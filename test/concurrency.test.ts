import { env, evictDurableObject } from 'cloudflare:test';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { StreamDO } from '../src/do/stream';
import type { RateLimiterDO } from '../src/do/rate-limiter';
import { client, forceDigestToYield, seedKey } from './helpers';
import { sha256Hex } from '../src/lib/hash';

function streamStub(streamId: string): DurableObjectStub<StreamDO> {
  const ns = env.STREAM as unknown as DurableObjectNamespace<StreamDO>;
  return ns.get(ns.idFromName(streamId));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// The project's headline guarantee (strict serialization) rests on
// blockConcurrencyWhile closing the interleave window at the crypto.subtle
// await. These tests put appends genuinely in flight together AND force that
// await to yield, so removing or narrowing the guard fails them. (Without the
// guard, 20 appends here collapse onto seqs like 1,1,2,2,2,...)
describe('concurrent appends', () => {
  it('assigns each of 20 in-flight appends a unique, contiguous seq', async () => {
    const stub = streamStub('concurrent-stream');
    await stub.create('concurrent-stream');
    forceDigestToYield();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => stub.append({ i }, `c-${i}`)),
    );

    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect((await stub.head()).count).toBe(20);
    expect(await stub.verify()).toEqual({ valid: true });
  });

  it('collapses 5 in-flight appends sharing one Idempotency-Key to one event', async () => {
    const stub = streamStub('concurrent-idem-stream');
    await stub.create('concurrent-idem-stream');
    forceDigestToYield();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => stub.append({ v: 1 }, 'same-key')),
    );

    expect(new Set(results.map((r) => r.seq)).size).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual([
      'created',
      'replayed',
      'replayed',
      'replayed',
      'replayed',
    ]);
    expect((await stub.head()).count).toBe(1);
  });
});

// All authoritative state must live in storage: a DO can be evicted at any
// moment, and an instance-field cache of meta or the idempotency map would
// pass every single-instance test while breaking exactly-once in production.
describe('durability across DO eviction', () => {
  it('stream state (seq, idempotency, chain) survives eviction', async () => {
    const stub = streamStub('evict-stream');
    await stub.create('evict-stream');
    const first = await stub.append({ a: 1 }, 'k1');
    await stub.append({ a: 2 }, 'k2');

    await evictDurableObject(stub);

    // Sequence continues, no restart from 1.
    const third = await stub.append({ a: 3 }, 'k3');
    expect(third.seq).toBe(3);

    // Idempotency records survive: k1 replays the original event, and is
    // still bound to its original payload.
    const replay = await stub.append({ a: 1 }, 'k1');
    expect(replay).toMatchObject({ status: 'replayed', seq: first.seq });
    expect(replay.status === 'replayed' && replay.hash).toBe(
      first.status === 'created' && first.hash,
    );
    expect(await stub.append({ a: 999 }, 'k1')).toEqual({
      status: 'conflict',
      seq: first.seq,
    });

    expect((await stub.head()).count).toBe(3);
    expect(await stub.verify()).toEqual({ valid: true });
  });

  it('rate-limit bucket state survives eviction (drained stays drained)', async () => {
    const raw = await seedKey({ ratePerMin: 2 });
    const api = client(raw);
    await api.createStream(); // token 1
    expect((await api.fetch('/v1/streams', { method: 'POST' })).status).toBe(201); // token 2
    expect((await api.fetch('/v1/streams', { method: 'POST' })).status).toBe(429);

    const ns = env.RATE_LIMITER as unknown as DurableObjectNamespace<RateLimiterDO>;
    const stub = ns.get(ns.idFromName(await sha256Hex(raw)));
    await evictDurableObject(stub);

    // A fresh in-memory bucket would refill to capacity here.
    expect((await api.fetch('/v1/streams', { method: 'POST' })).status).toBe(429);
  });
});
