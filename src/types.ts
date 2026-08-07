/** Bindings available to the Worker and Durable Objects (see wrangler.toml). */
export interface Env {
  /** StreamDO namespace: one instance per stream. */
  STREAM: DurableObjectNamespace;
  /** RateLimiterDO namespace: one instance per API key. */
  RATE_LIMITER: DurableObjectNamespace;
  /** D1 read model. */
  DB: D1Database;
  /** Guards the admin key-minting endpoint. */
  ADMIN_SECRET: string;
}
