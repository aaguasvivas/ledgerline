import { env, SELF } from 'cloudflare:test';
import { vi } from 'vitest';
import { sha256Hex } from '../src/lib/hash';

const BASE = 'https://ledgerline.test';

/** A fetch bound to the service, returning the raw Response. */
export function fetchApi(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, init);
}

/**
 * Seed an API key directly into D1 (the same way the admin mint endpoint will)
 * and return the raw key. A generous default rate keeps unrelated tests clear of
 * the rate limiter.
 */
export async function seedKey(
  opts: { ratePerMin?: number; name?: string } = {},
): Promise<string> {
  const raw = `lk_test_${crypto.randomUUID().replace(/-/g, '')}`;
  const keyHash = await sha256Hex(raw);
  await env.DB.prepare(
    'INSERT INTO api_keys (key_hash, name, rate_per_min, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(keyHash, opts.name ?? 'test-key', opts.ratePerMin ?? 1000, Date.now())
    .run();
  return raw;
}

/** A client bound to a specific API key; sets the bearer header automatically. */
export function client(rawKey: string) {
  return {
    fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${rawKey}`);
      return fetchApi(path, { ...init, headers });
    },

    /** Create a stream and return its id. */
    async createStream(): Promise<string> {
      const res = await this.fetch('/v1/streams', { method: 'POST' });
      const body = (await res.json()) as { id: string };
      return body.id;
    },

    /** Append a payload with an idempotency key. */
    append(
      streamId: string,
      payload: unknown,
      idempotencyKey: string,
    ): Promise<Response> {
      return this.fetch(`/v1/streams/${streamId}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    },
  };
}

/** Convenience: seed a key and return a bound client. */
export async function seededClient(
  opts: { ratePerMin?: number; name?: string } = {},
): Promise<ReturnType<typeof client>> {
  return client(await seedKey(opts));
}

/**
 * Make crypto.subtle.digest wait on a timer before it resolves.
 *
 * workerd computes digests without opening a Durable Object's input gate, so
 * concurrent requests never actually interleave at that await on their own,
 * and a concurrency test would pass even with blockConcurrencyWhile removed.
 * A real (1 ms) timer opens the gate long enough for queued requests to be
 * delivered mid-append: the worst case the code defends against. Undo with
 * vi.restoreAllMocks().
 */
export function forceDigestToYield(): void {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return digest(algorithm, data);
  });
}
