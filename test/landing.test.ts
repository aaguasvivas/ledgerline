import { describe, it, expect } from 'vitest';
import { fetchApi } from './helpers';

describe('GET /', () => {
  it('serves a small HTML landing page', async () => {
    const res = await fetchApi('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Ledgerline');
  });
});
