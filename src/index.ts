import { Hono } from 'hono';
import type { Env } from './types';

/**
 * Ledgerline Worker entry point.
 *
 * The Worker is the stateless edge front door: it authenticates, rate-limits,
 * and routes requests to the authoritative Durable Objects, then projects
 * confirmed writes into the D1 read model.
 */
const app = new Hono<{ Bindings: Env }>();

/** Liveness probe — unauthenticated, no rate limit. */
app.get('/health', (c) => c.json({ status: 'ok' }));

export default app;

// Durable Objects are implemented in later phases. They are exported here (and
// declared in wrangler.toml) so the runtime can construct them.
export { StreamDO } from './do/stream';
export { RateLimiterDO } from './do/rate-limiter';
