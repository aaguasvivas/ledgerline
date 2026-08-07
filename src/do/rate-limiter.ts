import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { take, type BucketState } from '../lib/token-bucket';

const BUCKET_KEY = 'bucket';

/** Outcome of a token request. */
export interface TakeResult {
  allowed: boolean;
  /** Whole tokens left after this call. */
  remaining: number;
  /** Milliseconds until the next token is available (0 when allowed). */
  retryAfterMs: number;
}

/**
 * RateLimiterDO: one instance per API key; a persistent token bucket.
 *
 * Capacity is the burst ceiling and `refillPerMin` the sustained rate (both set
 * to the key's `rate_per_min`). Because the object is single-threaded and the
 * read-modify-write runs inside `blockConcurrencyWhile`, concurrent requests for
 * the same key cannot double-spend a token.
 */
export class RateLimiterDO extends DurableObject<Env> {
  /** Try to consume one token. */
  async take(capacity: number, refillPerMin: number): Promise<TakeResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const config = { capacity, refillPerMs: refillPerMin / 60_000 };

      const stored =
        (await this.ctx.storage.get<BucketState>(BUCKET_KEY)) ??
        ({ tokens: capacity, updatedAt: now } satisfies BucketState);

      const { allowed, state } = take(stored, now, config);
      await this.ctx.storage.put(BUCKET_KEY, state);

      const retryAfterMs = allowed
        ? 0
        : Math.ceil((1 - state.tokens) / config.refillPerMs);

      return { allowed, remaining: Math.floor(state.tokens), retryAfterMs };
    });
  }
}

/** Typed handle to the RateLimiterDO for a given key hash. */
export function rateLimiterStub(
  env: Env,
  keyHash: string,
): DurableObjectStub<RateLimiterDO> {
  return env.RATE_LIMITER.get(
    env.RATE_LIMITER.idFromName(keyHash),
  ) as unknown as DurableObjectStub<RateLimiterDO>;
}
