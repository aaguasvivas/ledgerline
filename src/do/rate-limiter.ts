import type { Env } from '../types';

/**
 * RateLimiterDO — one instance per API key; token-bucket limiter.
 * Implemented in Phase 4.
 */
export class RateLimiterDO {
  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
