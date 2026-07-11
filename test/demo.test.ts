import { describe, it, expect } from 'vitest';
import { fetchApi } from './helpers';

describe('GET /demo', () => {
  it('serves the interactive walkthrough without auth', async () => {
    const res = await fetchApi('/demo');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Ledgerline');
    // The tamper-the-chain widget is the point of the page.
    expect(html).toContain('id="chain"');
    expect(html).toContain('recomputing chain in your browser');
  });
});
