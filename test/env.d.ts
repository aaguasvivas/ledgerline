/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { Env as WorkerEnv } from '../src/types';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';

// In the vitest-pool-workers v4 line, `env` from `cloudflare:test` is typed as
// the global `Cloudflare.Env`. Augment it with the worker's bindings plus the
// test-only migrations list so tests are fully typed.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
