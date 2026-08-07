import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { canonicalize, genesisHash, nextHash } from '../lib/hash';

/** Per-stream metadata; the O(1) head of the log. */
interface Meta {
  /** The stream id this object was created for (used to derive the genesis hash). */
  streamId: string;
  /** Highest assigned sequence number (0 before the first append). */
  seq: number;
  /** Number of events in the stream. */
  count: number;
  /** Hash of the most recent event, or the genesis hash when empty. */
  headHash: string;
}

/** A persisted event. */
export interface StoredEvent {
  seq: number;
  prevHash: string;
  hash: string;
  payload: unknown;
  createdAt: number;
}

/** Idempotency record: maps an Idempotency-Key to the event it produced. */
interface IdemRecord {
  seq: number;
  hash: string;
}

/** Result of an append (or an idempotent replay). */
export interface AppendResult {
  seq: number;
  hash: string;
  prevHash: string;
  createdAt: number;
  /**
   * Canonical JSON of the authoritative payload. On a replay this is the
   * ORIGINAL event's payload (not the retried body), so a mirror always matches
   * `hash`. A string (not `unknown`) keeps the RPC return type serializable.
   */
  canonicalPayload: string;
  /** True when this call replayed an existing event for a repeated key. */
  replay: boolean;
}

const META_KEY = 'meta';

/** Zero-padded so DO storage `list()` returns events in seq order. */
function eventKey(seq: number): string {
  return `event:${String(seq).padStart(12, '0')}`;
}

function idemKey(key: string): string {
  return `idem:${key}`;
}

/** Per-minute rollup bucket key (minute = floor(epochMs / 60000)). */
function bucketKey(minute: number): string {
  return `bucket:${minute}`;
}

/** Typed handle to the StreamDO for a given stream id. */
export function streamStub(
  env: Env,
  streamId: string,
): DurableObjectStub<StreamDO> {
  return env.STREAM.get(
    env.STREAM.idFromName(streamId),
  ) as unknown as DurableObjectStub<StreamDO>;
}

/**
 * StreamDO: one instance per stream; the authoritative source of truth for
 * ordering and integrity.
 *
 * A Durable Object is single-threaded, so there is no shared-memory race to
 * guard against. The one remaining hazard is *interleaving across awaits*: an
 * append reads `meta`, awaits a SHA-256 digest, then writes, and a second
 * concurrent append could slip in at the digest await. We close that window by
 * running each mutation inside `blockConcurrencyWhile`, which defers delivery of
 * other events until the critical section completes. The result is strict
 * serialization (monotonic `seq` and exactly-once appends) with no locks,
 * leases, or coordination beyond the platform.
 */
export class StreamDO extends DurableObject<Env> {
  /**
   * Initialize the stream. Idempotent: calling it again is a no-op so stream
   * creation can be safely retried.
   */
  async create(streamId: string): Promise<{ created: boolean }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.get<Meta>(META_KEY);
      if (existing) return { created: false };

      const headHash = await genesisHash(streamId);
      await this.ctx.storage.put<Meta>(META_KEY, {
        streamId,
        seq: 0,
        count: 0,
        headHash,
      });
      return { created: true };
    });
  }

  /**
   * Append a payload under an idempotency key.
   *
   * If the key was used before, the original event is returned unchanged with
   * `replay: true` and nothing is written: exactly-once under client retries.
   * Otherwise a new event is linked into the hash chain and `meta`, the event,
   * and the idempotency record are committed in a single atomic batch.
   */
  async append(payload: unknown, idempotencyKey: string): Promise<AppendResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const meta = await this.ctx.storage.get<Meta>(META_KEY);
      if (!meta) throw new Error('stream not initialized');

      const prior = await this.ctx.storage.get<IdemRecord>(
        idemKey(idempotencyKey),
      );
      if (prior) {
        const event = await this.ctx.storage.get<StoredEvent>(
          eventKey(prior.seq),
        );
        return {
          seq: prior.seq,
          hash: prior.hash,
          prevHash: event!.prevHash,
          createdAt: event!.createdAt,
          canonicalPayload: canonicalize(event!.payload),
          replay: true,
        };
      }

      const seq = meta.seq + 1;
      const prevHash = meta.headHash;
      const hash = await nextHash(prevHash, payload, seq);
      const createdAt = Date.now();
      const event: StoredEvent = { seq, prevHash, hash, payload, createdAt };

      const minute = Math.floor(createdAt / 60000);
      const existingBucket = await this.ctx.storage.get<number>(
        bucketKey(minute),
      );

      // One batched put → atomic commit of every key this append touches.
      await this.ctx.storage.put({
        [eventKey(seq)]: event,
        [idemKey(idempotencyKey)]: { seq, hash } satisfies IdemRecord,
        [bucketKey(minute)]: (existingBucket ?? 0) + 1,
        [META_KEY]: { ...meta, seq, count: meta.count + 1, headHash: hash },
      });

      // First append of a new minute: drop rollup buckets that have aged out
      // of the stats window, keeping bucket storage bounded (~60 keys) instead
      // of growing one key per active minute forever.
      if (existingBucket === undefined) {
        await this.pruneBuckets(minute - 59);
      }

      return {
        seq,
        hash,
        prevHash,
        createdAt,
        canonicalPayload: canonicalize(payload),
        replay: false,
      };
    });
  }

  /** O(1) head of the log: total count and the current head hash. */
  async head(): Promise<{ count: number; headHash: string }> {
    const meta = await this.ctx.storage.get<Meta>(META_KEY);
    if (!meta) throw new Error('stream not initialized');
    return { count: meta.count, headHash: meta.headHash };
  }

  /**
   * Time-series rollup: total event count plus per-minute counts for the last
   * 60 minutes (only minutes with activity are returned), ascending by minute.
   */
  async stats(): Promise<{
    total: number;
    perMinute: { minute: number; count: number }[];
  }> {
    const meta = await this.ctx.storage.get<Meta>(META_KEY);
    const total = meta?.count ?? 0;

    const windowStart = Math.floor(Date.now() / 60000) - 59;
    const buckets = await this.ctx.storage.list<number>({ prefix: 'bucket:' });

    const perMinute: { minute: number; count: number }[] = [];
    for (const [key, count] of buckets) {
      const minute = Number(key.slice('bucket:'.length));
      if (minute >= windowStart) perMinute.push({ minute, count });
    }
    perMinute.sort((a, b) => a.minute - b.minute);

    return { total, perMinute };
  }

  /**
   * Recompute the hash chain from genesis and report the first sequence number
   * whose stored hash diverges from the recomputed value. An untampered stream
   * returns `{ valid: true }`.
   */
  async verify(): Promise<{ valid: boolean; brokenAt?: number }> {
    const meta = await this.ctx.storage.get<Meta>(META_KEY);
    // Missing meta means the authoritative state is gone (storage loss, botched
    // migration). Fail loudly, like head(); never report a vanished log as valid.
    if (!meta) throw new Error('stream not initialized');

    let prev = await genesisHash(meta.streamId);
    let count = 0;
    let lastSeq = 0;
    for await (const event of this.iterateEvents()) {
      const expected = await nextHash(prev, event.payload, event.seq);
      if (expected !== event.hash) {
        return { valid: false, brokenAt: event.seq };
      }
      prev = expected;
      count += 1;
      lastSeq = event.seq;
    }

    // The links recomputed cleanly; now confirm this is the WHOLE chain.
    // Tail truncation leaves a clean prefix; meta commits to the true head, so
    // compare both the event count and the final hash against it.
    if (count !== meta.count || prev !== meta.headHash) {
      return { valid: false, brokenAt: lastSeq + 1 };
    }
    return { valid: true };
  }

  /** Delete rollup buckets for minutes before `oldestKept`. */
  private async pruneBuckets(oldestKept: number): Promise<void> {
    const buckets = await this.ctx.storage.list<number>({ prefix: 'bucket:' });
    const stale: string[] = [];
    for (const key of buckets.keys()) {
      if (Number(key.slice('bucket:'.length)) < oldestKept) stale.push(key);
    }
    // storage.delete accepts at most 128 keys per call.
    for (let i = 0; i < stale.length; i += 128) {
      await this.ctx.storage.delete(stale.slice(i, i + 128));
    }
  }

  /** Yield every stored event in ascending seq order, paginating storage. */
  private async *iterateEvents(): AsyncGenerator<StoredEvent> {
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.ctx.storage.list<StoredEvent>({
        prefix: 'event:',
        startAfter: cursor,
        limit: 1000,
      });
      if (batch.size === 0) break;
      for (const [key, event] of batch) {
        cursor = key;
        yield event;
      }
      if (batch.size < 1000) break;
    }
  }
}
