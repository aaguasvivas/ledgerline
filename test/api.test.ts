import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { seededClient } from './helpers';
import type { StreamDO } from '../src/do/stream';

let api: Awaited<ReturnType<typeof seededClient>>;

beforeEach(async () => {
  api = await seededClient();
});

describe('POST /v1/streams', () => {
  it('creates a stream and returns its id', async () => {
    const res = await api.fetch('/v1/streams', { method: 'POST' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });
});

describe('POST /v1/streams/:id/events', () => {
  it('appends an event and returns { seq, hash }', async () => {
    const id = await api.createStream();
    const res = await api.append(id, { amount: 100, currency: 'USD' }, 'k1');

    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotent-Replay')).toBeNull();
    const body = (await res.json()) as { seq: number; hash: string };
    expect(body.seq).toBe(1);
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requires an Idempotency-Key (400 otherwise)', async () => {
    const id = await api.createStream();
    const res = await api.fetch(`/v1/streams/${id}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_key_required');
  });

  // Spec test 1: exactly-once.
  it('replays the original event for a repeated key and appends nothing new', async () => {
    const id = await api.createStream();
    const first = (await (
      await api.append(id, { amount: 100 }, 'dup')
    ).json()) as { seq: number; hash: string };

    const replayRes = await api.append(id, { amount: 100 }, 'dup');
    expect(replayRes.status).toBe(200);
    expect(replayRes.headers.get('Idempotent-Replay')).toBe('true');
    const replay = (await replayRes.json()) as { seq: number; hash: string };
    expect(replay).toEqual(first);

    const head = (await (await api.fetch(`/v1/streams/${id}/head`)).json()) as {
      count: number;
    };
    expect(head.count).toBe(1);
  });

  // Spec test 2: ordering.
  it('assigns strictly increasing, contiguous seq numbers', async () => {
    const id = await api.createStream();
    const seqs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const body = (await (
        await api.append(id, { i }, `seq-${i}`)
      ).json()) as { seq: number };
      seqs.push(body.seq);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('unicode payloads end-to-end', () => {
  it('round-trips through DO storage and D1 with a recomputable hash', async () => {
    const id = await api.createStream();
    const payload = { note: 'café ✅ — 分散台帳', emoji: '🚀🔗' };

    const appended = (await (
      await api.append(id, payload, 'uni-1')
    ).json()) as { seq: number; hash: string };

    const body = (await (
      await api.fetch(`/v1/streams/${id}/events`)
    ).json()) as { events: { seq: number; hash: string; payload: unknown }[] };
    expect(body.events[0].payload).toEqual(payload);

    // The read model's payload recomputes to the stored hash byte-for-byte;
    // the independent-auditability contract.
    const { genesisHash, nextHash } = await import('../src/lib/hash');
    const recomputed = await nextHash(await genesisHash(id), body.events[0].payload, 1);
    expect(recomputed).toBe(appended.hash);

    expect(await (await api.fetch(`/v1/streams/${id}/verify`)).json()).toEqual({
      valid: true,
    });
  });
});

describe('GET /v1/streams/:id/head', () => {
  it('returns count and head hash', async () => {
    const id = await api.createStream();
    await api.append(id, { a: 1 }, 'h1');
    await api.append(id, { a: 2 }, 'h2');

    const res = await api.fetch(`/v1/streams/${id}/head`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; headHash: string };
    expect(body.count).toBe(2);
    expect(body.headHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Spec test 6: read model.
describe('GET /v1/streams/:id/events (D1 read model)', () => {
  it('returns mirrored events with pagination', async () => {
    const id = await api.createStream();
    for (let i = 0; i < 5; i++) await api.append(id, { i }, `r-${i}`);

    const res = await api.fetch(`/v1/streams/${id}/events?after=0&limit=3`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { seq: number; payload: unknown }[];
      nextAfter: number | null;
    };
    expect(body.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(body.events[0].payload).toEqual({ i: 0 });
    expect(body.nextAfter).toBe(3);

    const page2 = (await (
      await api.fetch(`/v1/streams/${id}/events?after=3&limit=3`)
    ).json()) as { events: { seq: number }[]; nextAfter: number | null };
    expect(page2.events.map((e) => e.seq)).toEqual([4, 5]);
    expect(page2.nextAfter).toBeNull();
  });

  it('clamps and defaults pagination params (real assertions, 55-event stream)', async () => {
    const id = await api.createStream();
    for (let i = 0; i < 55; i++) await api.append(id, { i }, `p-${i}`);

    const page = async (query: string) =>
      (await (
        await api.fetch(`/v1/streams/${id}/events${query}`)
      ).json()) as { events: { seq: number }[] };

    // Default limit is 50.
    expect((await page('')).events).toHaveLength(50);
    // Garbage limit falls back to the default.
    expect((await page('?limit=abc')).events).toHaveLength(50);
    // limit is clamped up to at least 1, and must not 500 on an empty page.
    expect((await page('?limit=0')).events).toHaveLength(1);
    expect((await page('?limit=-3')).events).toHaveLength(1);
    // Exponent notation is a real number, not parseInt-truncated to 1.
    expect((await page('?limit=1e3')).events).toHaveLength(55);
    // Negative or garbage `after` starts from the beginning.
    expect((await page('?after=-5&limit=1')).events[0].seq).toBe(1);
    expect((await page('?after=abc&limit=1')).events[0].seq).toBe(1);
  });
});

// Spec test 6: rollups.
describe('GET /v1/streams/:id/stats', () => {
  it('reports total and per-minute counts after appends', async () => {
    const id = await api.createStream();
    for (let i = 0; i < 4; i++) await api.append(id, { i }, `s-${i}`);

    const res = await api.fetch(`/v1/streams/${id}/stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      perMinute: { minute: number; count: number }[];
    };
    expect(body.total).toBe(4);
    const summed = body.perMinute.reduce((acc, b) => acc + b.count, 0);
    expect(summed).toBe(4);
    expect(body.perMinute.length).toBeGreaterThanOrEqual(1);
  });
});

// Spec test 3: hash-chain integrity over HTTP.
describe('GET /v1/streams/:id/verify', () => {
  it('verifies an untampered chain', async () => {
    const id = await api.createStream();
    for (let i = 0; i < 3; i++) await api.append(id, { i }, `v-${i}`);

    const res = await api.fetch(`/v1/streams/${id}/verify`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });

  it('detects tampering and reports the first divergent seq', async () => {
    const id = await api.createStream();
    for (let i = 1; i <= 3; i++) await api.append(id, { i }, `vt-${i}`);

    const ns = env.STREAM as unknown as DurableObjectNamespace<StreamDO>;
    const stub = ns.get(ns.idFromName(id));
    await runInDurableObject(stub, async (_instance, state) => {
      const events = await state.storage.list<{ seq: number; payload: unknown }>(
        { prefix: 'event:' },
      );
      for (const [key, event] of events) {
        if (event.seq === 2) {
          await state.storage.put(key, { ...event, payload: { i: 'tampered' } });
        }
      }
    });

    const res = await api.fetch(`/v1/streams/${id}/verify`);
    expect(await res.json()).toEqual({ valid: false, brokenAt: 2 });
  });
});

describe('unknown streams', () => {
  it('returns 404 for a stream that does not exist', async () => {
    const res = await api.fetch(`/v1/streams/${crypto.randomUUID()}/head`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('stream_not_found');
  });
});
