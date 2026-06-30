import type { Context, Next } from 'hono';
import type { AppEnv } from './auth';
import { ApiError } from './errors';
import { log } from './log';
import { rateLimiterStub } from '../do/rate-limiter';

/**
 * Per-key token-bucket rate limiting. Must run after `authenticate` (it needs
 * the resolved key). Every request spends one token before any work; an empty
 * bucket yields 429 with `Retry-After`. Standard `RateLimit-*` headers are set
 * on every response.
 */
export async function rateLimit(c: Context<AppEnv>, next: Next): Promise<void> {
  const keyHash = c.get('keyHash');
  const ratePerMin = c.get('ratePerMin');

  const { allowed, remaining, retryAfterMs } = await rateLimiterStub(
    c.env,
    keyHash,
  ).take(ratePerMin, ratePerMin);

  c.header('RateLimit-Limit', String(ratePerMin));
  c.header('RateLimit-Remaining', String(remaining));

  if (!allowed) {
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    c.header('Retry-After', String(retryAfterSec));
    log.warn('rate_limited', { keyName: c.get('keyName'), ratePerMin });
    throw new ApiError(429, 'rate_limited', 'Rate limit exceeded');
  }

  await next();
}
