/**
 * Pure token-bucket logic.
 *
 * Kept free of any I/O or clock access so it can be reasoned about and tested
 * deterministically by injecting `now`. The RateLimiterDO wraps these functions
 * with persistent storage and `Date.now()`.
 */

export interface BucketState {
  /** Current token count (fractional; refills continuously). */
  tokens: number;
  /** Timestamp (ms) the state was last updated. */
  updatedAt: number;
}

export interface BucketConfig {
  /** Maximum tokens (the burst ceiling). */
  capacity: number;
  /** Tokens added per millisecond. */
  refillPerMs: number;
}

/** Return state refilled up to `now`, capped at capacity. Never mutates input. */
export function refill(
  state: BucketState,
  now: number,
  config: BucketConfig,
): BucketState {
  const elapsed = Math.max(0, now - state.updatedAt);
  const tokens = Math.min(
    config.capacity,
    state.tokens + elapsed * config.refillPerMs,
  );
  return { tokens, updatedAt: now };
}

/**
 * Attempt to consume one token at time `now`. Refills first, then consumes if a
 * whole token is available. Returns whether it was allowed and the next state.
 */
export function take(
  state: BucketState,
  now: number,
  config: BucketConfig,
): { allowed: boolean; state: BucketState } {
  const refilled = refill(state, now, config);
  if (refilled.tokens >= 1) {
    return {
      allowed: true,
      state: { tokens: refilled.tokens - 1, updatedAt: now },
    };
  }
  return { allowed: false, state: refilled };
}
