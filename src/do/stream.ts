import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { canonicalize, genesisHash, nextHash } from '../lib/hash';
import { mirrorStatement } from '../lib/read-model';
import { log } from '../lib/log';

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

/** A committed event, as returned to the Worker for the response and mirror. */
export interface CommittedEvent {
  seq: number;
  hash: string;
  prevHash: string;
  createdAt: number;
  /**
   * Canonical JSON of the authoritative payload, so a mirror always matches
   * `hash`. A string (not `unknown`) keeps the RPC return type serializable.
   */
  canonicalPayload: string;
}

/**
 * Outcome of an append.
 * - `created`: a new event was committed.
 * - `replayed`: the key was used before with the same payload; the original
 *   event comes back and nothing is written.
 * - `conflict`: the key was used before with a DIFFERENT payload; nothing is
 *   written, and the caller must not report success.
 */
export type AppendResult =
  | ({ status: 'created' | 'replayed' } & CommittedEvent)
  | { status: 'conflict'; seq: number };

/** Result of a chain verification. */
export interface VerifyResult {
  valid: boolean;
  /** First seq that is missing, out of order, or fails to link. */
  brokenAt?: number;
}

const META_KEY = 'meta';

/** Highest seq the outbox sweep has confirmed in D1. Only alarm() writes it. */
const MIRRORED_KEY = 'mirror:through';

/**
 * Delay between an append and the outbox sweep that guarantees it reaches D1.
 * The Worker's inline mirror normally lands first, so the sweep is usually a
 * no-op confirmation; it exists for the times the inline write does not.
 */
const MIRROR_SWEEP_DELAY_MS = 5_000;

/** Back-off after a failed sweep. The alarm reschedules itself indefinitely. */
const MIRROR_RETRY_DELAY_MS = 30_000;

/** Events per D1 batch (one transaction). */
const MIRROR_BATCH_SIZE = 100;

/** Batches per sweep; a larger backlog continues in a fresh alarm invocation. */
const MIRROR_MAX_BATCHES = 10;

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
 *
 * The object also owns delivery to the D1 read model: every append arms an
 * alarm, and alarm() sweeps committed events into D1 until it confirms the
 * head (a transactional outbox), so the projection converges even when the
 * Worker's inline mirror write fails.
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
   * A key is bound to its first payload for the life of the stream. Reusing it
   * with the same payload replays the original event (exactly-once under
   * client retries); reusing it with a different payload is a `conflict`, so a
   * client bug cannot be silently absorbed as a success. Otherwise a new event
   * is linked into the hash chain and the event, idempotency record, rollup
   * bucket, and `meta` are committed in a single atomic batch.
   */
  async append(payload: unknown, idempotencyKey: string): Promise<AppendResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const meta = await this.ctx.storage.get<Meta>(META_KEY);
      if (!meta) throw new Error('stream not initialized');

      const canonicalPayload = canonicalize(payload);

      const prior = await this.ctx.storage.get<IdemRecord>(
        idemKey(idempotencyKey),
      );
      if (prior) {
        const event = (await this.ctx.storage.get<StoredEvent>(
          eventKey(prior.seq),
        ))!;
        const original = canonicalize(event.payload);
        // Compare canonical forms: a retry that only re-serializes the body
        // (different key order or whitespace) is the same request.
        if (original !== canonicalPayload) {
          return { status: 'conflict', seq: prior.seq };
        }
        return {
          status: 'replayed',
          seq: prior.seq,
          hash: prior.hash,
          prevHash: event.prevHash,
          createdAt: event.createdAt,
          canonicalPayload: original,
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
      const sweepPending = (await this.ctx.storage.getAlarm()) !== null;

      // One batched put → atomic commit of every key this append touches. The
      // outbox alarm is armed in the same breath (no await in between, so the
      // platform coalesces both into one atomic write), but never pushed back
      // when one is already pending: under steady traffic a timer reset on
      // every append would never fire.
      const writes = [
        this.ctx.storage.put({
          [eventKey(seq)]: event,
          [idemKey(idempotencyKey)]: { seq, hash } satisfies IdemRecord,
          [bucketKey(minute)]: (existingBucket ?? 0) + 1,
          [META_KEY]: { ...meta, seq, count: meta.count + 1, headHash: hash },
        }),
      ];
      if (!sweepPending) {
        writes.push(this.ctx.storage.setAlarm(createdAt + MIRROR_SWEEP_DELAY_MS));
      }
      await Promise.all(writes);

      // First append of a new minute: drop rollup buckets that have aged out
      // of the stats window, keeping bucket storage bounded (~60 keys) instead
      // of growing one key per active minute forever.
      if (existingBucket === undefined) {
        await this.pruneBuckets(minute - 59);
      }

      return {
        status: 'created',
        seq,
        hash,
        prevHash,
        createdAt,
        canonicalPayload,
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
   * that is missing, out of order, or fails to link. An untampered stream
   * returns `{ valid: true }`.
   *
   * Every stored field that the chain vouches for is checked: `seq` must be
   * contiguous, `prevHash` must equal the recomputed previous hash, and `hash`
   * must equal the recomputed link. The walk then compares its result with
   * `meta`, which commits to the true head, so tail truncation is caught too.
   */
  async verify(): Promise<VerifyResult> {
    const meta = await this.ctx.storage.get<Meta>(META_KEY);
    // Missing meta means the authoritative state is gone (storage loss, botched
    // migration). Fail loudly, like head(); never report a vanished log as valid.
    if (!meta) throw new Error('stream not initialized');

    // Walk exactly the history this snapshot of `meta` commits to. If the
    // runtime ever delivered an append during one of the awaits below, its
    // event would sit past `meta.seq` and must not read as tampering.
    let prev = await genesisHash(meta.streamId);
    let seq = 0;
    for await (const event of this.iterateEvents(meta.seq)) {
      seq += 1;
      if (event.seq !== seq || event.prevHash !== prev) {
        return { valid: false, brokenAt: seq };
      }
      const expected = await nextHash(prev, event.payload, seq);
      if (expected !== event.hash) {
        return { valid: false, brokenAt: seq };
      }
      prev = expected;
    }

    // The links recomputed cleanly; now confirm this is the WHOLE chain.
    // Tail truncation leaves a clean prefix; meta commits to the true head, so
    // compare both the event count and the final hash against it.
    if (seq !== meta.count || prev !== meta.headHash) {
      return { valid: false, brokenAt: seq + 1 };
    }
    return { valid: true };
  }

  /**
   * Outbox sweep: project committed events into the D1 read model, from the
   * last confirmed seq toward the head, then advance the confirmed watermark.
   *
   * Rows are written with INSERT OR IGNORE, so re-sending events the Worker
   * already mirrored inline is harmless. A failed batch is logged and retried
   * on our own schedule rather than by throwing: the platform's alarm retries
   * stop after a handful of attempts, and the read model must converge no
   * matter how long D1 is unreachable.
   */
  override async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<Meta>(META_KEY);
    if (!meta) return;
    let through = (await this.ctx.storage.get<number>(MIRRORED_KEY)) ?? 0;

    for (let round = 0; round < MIRROR_MAX_BATCHES; round++) {
      // Re-read the head every round: the D1 round-trip below yields, so
      // appends may have committed since the last batch.
      const head = (await this.ctx.storage.get<Meta>(META_KEY))!.seq;
      if (through >= head) return;

      const batch = await this.ctx.storage.list<StoredEvent>({
        prefix: 'event:',
        startAfter: eventKey(through),
        end: eventKey(head + 1),
        limit: MIRROR_BATCH_SIZE,
      });
      const events = [...batch.values()];
      if (events.length === 0) {
        // meta claims events the store does not have; verify() reports this.
        log.error('mirror_events_missing', { streamId: meta.streamId, through });
        return;
      }

      try {
        await this.env.DB.batch(
          events.map((event) =>
            mirrorStatement(this.env.DB, meta.streamId, {
              seq: event.seq,
              hash: event.hash,
              prevHash: event.prevHash,
              canonicalPayload: canonicalize(event.payload),
              createdAt: event.createdAt,
            }),
          ),
        );
      } catch (err) {
        log.error('mirror_sweep_failed', {
          streamId: meta.streamId,
          fromSeq: through + 1,
          message: err instanceof Error ? err.message : String(err),
        });
        await this.ctx.storage.setAlarm(Date.now() + MIRROR_RETRY_DELAY_MS);
        return;
      }

      through = events[events.length - 1].seq;
      await this.ctx.storage.put(MIRRORED_KEY, through);
    }

    // Still behind after a bounded amount of work: continue in a new run.
    await this.ctx.storage.setAlarm(Date.now());
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

  /** Yield stored events with seq <= `throughSeq`, ascending, paginating storage. */
  private async *iterateEvents(throughSeq: number): AsyncGenerator<StoredEvent> {
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.ctx.storage.list<StoredEvent>({
        prefix: 'event:',
        startAfter: cursor,
        end: eventKey(throughSeq + 1),
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
