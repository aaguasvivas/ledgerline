import { applyD1Migrations, env } from 'cloudflare:test';

// Apply D1 migrations once per test worker before any test runs. The migrations
// list is provided as a binding by vitest.config.ts.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
