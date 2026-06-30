import { describe, it, expect } from 'vitest';
import { take, refill, type BucketState } from '../src/lib/token-bucket';

// 5 tokens per minute.
const config = { capacity: 5, refillPerMs: 5 / 60000 };

describe('token bucket', () => {
  it('allows up to capacity then denies (no time passing)', () => {
    let state: BucketState = { tokens: 5, updatedAt: 0 };
    const allowed: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const result = take(state, 0, config);
      allowed.push(result.allowed);
      state = result.state;
    }
    expect(allowed).toEqual([true, true, true, true, true, false]);
  });

  it('refills over time', () => {
    // Empty bucket; 12s later one token is available again (5/min).
    const result = take({ tokens: 0, updatedAt: 0 }, 12_000, config);
    expect(result.allowed).toBe(true);
  });

  it('never refills beyond capacity', () => {
    const result = refill({ tokens: 0, updatedAt: 0 }, 60 * 60_000, config);
    expect(result.tokens).toBe(5);
  });

  it('does not refill when no time passes', () => {
    expect(refill({ tokens: 2, updatedAt: 1_000 }, 1_000, config).tokens).toBe(2);
  });
});
