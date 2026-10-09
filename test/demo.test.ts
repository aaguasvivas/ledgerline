import { describe, it, expect } from 'vitest';
import { fetchApi } from './helpers';

describe('GET /demo', () => {
  it('permanently redirects old walkthrough links to the demo on /', async () => {
    const res = await fetchApi('/demo', { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/#tamper');
  });
});
