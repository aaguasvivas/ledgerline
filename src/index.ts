import { app } from './worker/app';

/**
 * Ledgerline Worker entry point.
 *
 * The Worker is the stateless edge front door: it authenticates, rate-limits,
 * and routes requests to the authoritative Durable Objects, then projects
 * confirmed writes into the D1 read model.
 */
export default app;

// Durable Objects are declared in wrangler.toml and exported here so the
// runtime can construct them.
export { StreamDO } from './do/stream';
export { RateLimiterDO } from './do/rate-limiter';
