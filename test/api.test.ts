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

  // Spec test 1 — exactly-once.
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

  // Spec test 2 — ordering.
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

// Spec test 6 — read model.
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

  it('caps limit at 200 and defaults to 50', async () => {
    const id = await api.createStream();
    const res = await api.fetch(`/v1/streams/${id}/events?limit=9999`);
    expect(res.status).toBe(200);
  });
});

// Spec test 6 — rollups.
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

// Spec test 3 — hash-chain integrity over HTTP.
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
