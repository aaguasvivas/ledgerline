import { defineConfig } from 'vitest/config';
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';

/**
 * Vitest runs inside the real Workers runtime (workerd) via Miniflare, so tests
 * exercise actual Durable Objects and a local D1 database, not mocks.
 *
 * D1 migrations are read at config time and handed to the test worker as a
 * binding; `test/apply-migrations.ts` applies them before each test file.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations('./migrations');
      return {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            // Test-only secret. Production sets this via `wrangler secret put`.
            ADMIN_SECRET: 'test-admin-secret',
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
