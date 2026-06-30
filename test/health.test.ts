import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('GET /health', () => {
  it('returns { status: "ok" } with a 200', async () => {
    const res = await SELF.fetch('https://ledgerline.test/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
