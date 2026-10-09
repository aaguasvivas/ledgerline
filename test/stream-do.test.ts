import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { StoredEvent, StreamDO } from '../src/do/stream';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Typed handle to a StreamDO instance addressed by stream id. */
function streamStub(streamId: string): DurableObjectStub<StreamDO> {
  const ns = env.STREAM as unknown as DurableObjectNamespace<StreamDO>;
  return ns.get(ns.idFromName(streamId));
}

/** Create a stream and append `n` events ({ i } under key `k-i`, i from 1). */
async function streamWith(id: string, n: number) {
  const stub = streamStub(id);
  await stub.create(id);
  for (let i = 1; i <= n; i++) await stub.append({ i }, `k-${i}`);
  return stub;
}

/** Rewrite (or, with `null`, delete) the stored event at `seq`, as an attacker with storage access would. */
async function tamper(
  stub: DurableObjectStub<StreamDO>,
  seq: number,
  edit: (event: StoredEvent) => StoredEvent | null,
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const events = await state.storage.list<StoredEvent>({ prefix: 'event:' });
    for (const [key, event] of events) {
      if (event.seq !== seq) continue;
      const next = edit(event);
      if (next === null) await state.storage.delete(key);
      else await state.storage.put(key, next);
    }
  });
}

describe('StreamDO ordering', () => {
  it('assigns strictly increasing, contiguous seq numbers starting at 1', async () => {
    const stub = streamStub('order-stream');
    await stub.create('order-stream');

    const seqs: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await stub.append({ i }, `order-key-${i}`);
      seqs.push(res.seq);
    }

    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));

    const head = await stub.head();
    expect(head.count).toBe(25);

    const verified = await stub.verify();
    expect(verified).toEqual({ valid: true });
  });
});

describe('StreamDO exactly-once (idempotency)', () => {
  it('returns the original result on a repeated key and appends no new event', async () => {
    const stub = streamStub('idem-stream');
    await stub.create('idem-stream');

    const first = await stub.append({ amount: 100 }, 'same-key');
    expect(first.status).toBe('created');

    const second = await stub.append({ amount: 100 }, 'same-key');
    expect(second.status).toBe('replayed');
    expect(second).toEqual({ ...first, status: 'replayed' });

    // Exactly one event exists.
    expect((await stub.head()).count).toBe(1);
  });

  it('replays a retry whose body only differs in key order (canonical comparison)', async () => {
    const stub = streamStub('idem-reorder-stream');
    await stub.create('idem-reorder-stream');

    const first = await stub.append({ a: 1, b: { c: 2, d: 3 } }, 'k');
    const retry = await stub.append({ b: { d: 3, c: 2 }, a: 1 }, 'k');

    expect(retry).toEqual({ ...first, status: 'replayed' });
  });

  it('refuses to reuse a key with a different payload, and writes nothing', async () => {
    const stub = streamStub('idem-conflict-stream');
    await stub.create('idem-conflict-stream');

    const first = await stub.append({ v: 'original' }, 'dup');
    const second = await stub.append({ v: 'changed' }, 'dup');

    expect(second).toEqual({ status: 'conflict', seq: first.seq });
    expect((await stub.head()).count).toBe(1);
    // The key stays bound to the original: a faithful retry still replays.
    expect((await stub.append({ v: 'original' }, 'dup')).status).toBe('replayed');
  });
});

describe('StreamDO rollup buckets', () => {
  it('prunes buckets older than the 60-minute window on the first append of a minute', async () => {
    const stub = streamStub('prune-stream');
    await stub.create('prune-stream');

    // Seed one clearly-stale and one clearly-in-window bucket. Generous margins
    // (-90 / -30) keep the test immune to a minute boundary ticking mid-test.
    const nowMinute = Math.floor(Date.now() / 60000);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(`bucket:${nowMinute - 90}`, 7);
      await state.storage.put(`bucket:${nowMinute - 30}`, 4);
    });

    await stub.append({ a: 1 }, 'prune-1'); // first append of this minute

    const keys = await runInDurableObject(stub, async (_instance, state) => {
      const buckets = await state.storage.list({ prefix: 'bucket:' });
      return [...buckets.keys()];
    });
    expect(keys).not.toContain(`bucket:${nowMinute - 90}`);
    expect(keys).toContain(`bucket:${nowMinute - 30}`);

    // stats reflects the surviving seeded bucket plus the fresh append.
    const stats = await stub.stats();
    expect(stats.perMinute.reduce((acc, b) => acc + b.count, 0)).toBe(5);
  });

  it('stats window includes a bucket exactly 59 minutes old and excludes 60', async () => {
    const stub = streamStub('window-stream');
    await stub.create('window-stream');

    // Seed and read inside one DO callback so the boundary math uses the same
    // clock within a sub-millisecond window.
    const stats = await runInDurableObject(stub, async (instance, state) => {
      const nowMinute = Math.floor(Date.now() / 60000);
      await state.storage.put(`bucket:${nowMinute - 59}`, 3);
      await state.storage.put(`bucket:${nowMinute - 60}`, 9);
      return (instance as StreamDO).stats();
    });

    expect(stats.perMinute.some((b) => b.count === 3)).toBe(true);
    expect(stats.perMinute.some((b) => b.count === 9)).toBe(false);
  });
});

describe('StreamDO hash-chain integrity', () => {
  it('verifies an untampered chain', async () => {
    const stub = streamStub('verify-ok-stream');
    await stub.create('verify-ok-stream');
    for (let i = 0; i < 5; i++) await stub.append({ i }, `ok-${i}`);

    expect(await stub.verify()).toEqual({ valid: true });
  });

  it('detects tampering and reports the first divergent seq', async () => {
    const stub = await streamWith('verify-tampered-stream', 4);

    // Tamper with the stored payload of event seq=2, leaving its hash intact.
    await tamper(stub, 2, (event) => ({ ...event, payload: { i: 999 } }));

    expect(await stub.verify()).toEqual({ valid: false, brokenAt: 2 });
  });

  // Regression: verify recomputed links from its own running hash and never
  // looked at the stored prevHash, so a forged prevHash (served to clients by
  // GET /events) passed as valid.
  it('detects a forged prevHash even when every hash recomputes', async () => {
    const stub = await streamWith('verify-prevhash-stream', 3);

    await tamper(stub, 2, (event) => ({ ...event, prevHash: 'f'.repeat(64) }));

    expect(await stub.verify()).toEqual({ valid: false, brokenAt: 2 });
  });

  // Regression: deleting a middle event used to be reported at the NEXT seq,
  // pointing an investigator at an intact event instead of the missing one.
  it('reports a deleted middle event at its own seq', async () => {
    const stub = await streamWith('verify-gap-stream', 4);

    await tamper(stub, 2, () => null);

    expect(await stub.verify()).toEqual({ valid: false, brokenAt: 2 });
  });

  // verify reads meta, then walks the log across many awaits. If an append
  // commits in between, its event lies past the snapshot's head; counting it
  // made a healthy stream report { valid: false } under live traffic.
  it('verifies the head it started from when an append commits mid-walk', async () => {
    const stub = await streamWith('verify-snapshot-stream', 3);

    const result = await runInDurableObject(stub, async (obj) => {
      const instance = obj as StreamDO;
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let appended = false;
      // verify's first digest (the genesis hash) runs after it read meta:
      // commit seq 4 right there, as a concurrently delivered append would.
      vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
        if (!appended) {
          appended = true;
          await instance.append({ i: 4 }, 'k-4');
        }
        return digest(algorithm, data);
      });
      return instance.verify();
    });

    expect(result).toEqual({ valid: true });
    expect((await stub.head()).count).toBe(4);
    expect(await stub.verify()).toEqual({ valid: true });
  });

  // Tail truncation is the classic ledger rollback: deleting the trailing
  // event(s) leaves a chain that recomputes cleanly. verify must compare the
  // recomputed head against meta (count + headHash) to catch it.
  it('detects tail truncation (trailing event deleted, meta intact)', async () => {
    const stub = streamStub('verify-truncated-stream');
    await stub.create('verify-truncated-stream');
    for (let i = 1; i <= 3; i++) await stub.append({ i }, `tr-${i}`);

    await runInDurableObject(stub, async (_instance, state) => {
      const events = await state.storage.list<{ seq: number }>({
        prefix: 'event:',
      });
      for (const [key, event] of events) {
        if (event.seq === 3) await state.storage.delete(key);
      }
    });

    expect(await stub.verify()).toEqual({ valid: false, brokenAt: 3 });
  });

  it('throws for an uninitialized stream, consistent with head()', async () => {
    const stub = streamStub('verify-uninitialized-stream');
    // No create(): meta is absent. A false { valid: true } here would report a
    // vanished authoritative log as a healthy chain.
    // Explicit try/catch: RpcPromise thenables confuse vitest's `.rejects`
    // and leak unhandled-rejection warnings.
    const messages: string[] = [];
    for (const call of [() => stub.verify(), () => stub.head()]) {
      try {
        await call();
      } catch (err) {
        messages.push((err as Error).message);
      }
    }
    expect(messages).toEqual([
      'stream not initialized',
      'stream not initialized',
    ]);
  });
});
