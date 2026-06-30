import type { Env } from '../types';

/**
 * StreamDO — one instance per stream; the authoritative source of truth for
 * ordering and integrity. Implemented in Phase 2.
 */
export class StreamDO {
  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
