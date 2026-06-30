import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { client, seedKey } from './helpers';
import { sha256Hex } from '../src/lib/hash';
import type { RateLimiterDO } from '../src/do/rate-limiter';

interface StoredBucket {
  tokens: number;
  updatedAt: number;
}

// Spec test 4 — rate limiting.
describe('rate limiting', () => {
  it('returns 429 once a key exhausts its bucket within the window', async () => {
    const raw = await seedKey({ ratePerMin: 3 });
    const c = client(raw);
    const id = await c.createStream(); // token 1 of 3

    const r1 = await c.fetch(`/v1/streams/${id}/head`); // token 2
    const r2 = await c.fetch(`/v1/streams/${id}/head`); // token 3
    const r3 = await c.fetch(`/v1/streams/${id}/head`); // denied

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    const body = (await r3.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');
    expect(r3.headers.get('Retry-After')).not.toBeNull();
  });

  it('refills tokens as time passes', async () => {
    const raw = await seedKey({ ratePerMin: 2 });
    const c = client(raw);
    const id = await c.createStream(); // token 1 of 2
    expect((await c.fetch(`/v1/streams/${id}/head`)).status).toBe(200); // token 2
    expect((await c.fetch(`/v1/streams/${id}/head`)).status).toBe(429); // denied

    // Simulate a minute passing by rewinding the bucket's clock.
    const keyHash = await sha256Hex(raw);
    const ns = env.RATE_LIMITER as unknown as DurableObjectNamespace<RateLimiterDO>;
    const stub = ns.get(ns.idFromName(keyHash));
    await runInDurableObject(stub, async (_instance, state) => {
      const bucket = await state.storage.get<StoredBucket>('bucket');
      if (bucket) {
        await state.storage.put('bucket', {
          ...bucket,
          updatedAt: bucket.updatedAt - 60_000,
        });
      }
    });

    expect((await c.fetch(`/v1/streams/${id}/head`)).status).toBe(200);
  });
});
