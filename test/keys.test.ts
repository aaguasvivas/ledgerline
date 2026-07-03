import { describe, it, expect } from 'vitest';
import { fetchApi, client } from './helpers';

const ADMIN_SECRET = 'test-admin-secret';

describe('POST /v1/keys (admin)', () => {
  it('mints a usable key with the correct admin secret', async () => {
    const res = await fetchApi('/v1/keys', {
      method: 'POST',
      headers: {
        'X-Admin-Secret': ADMIN_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'acme', rate_per_min: 120 }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      key: string;
      name: string;
      rate_per_min: number;
    };
    expect(body.key).toMatch(/^lk_[0-9a-f]{48}$/);
    expect(body.name).toBe('acme');
    expect(body.rate_per_min).toBe(120);

    // The raw key is returned once and immediately authenticates.
    const created = await client(body.key).fetch('/v1/streams', {
      method: 'POST',
    });
    expect(created.status).toBe(201);
  });

  it('rejects a fractional rate_per_min with 400 instead of storing 0', async () => {
    const res = await fetchApi('/v1/keys', {
      method: 'POST',
      headers: { 'X-Admin-Secret': ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'frac', rate_per_min: 0.5 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_rate');
  });

  it('rejects a non-finite rate_per_min (JSON 1e999) with 400 instead of 500', async () => {
    const res = await fetchApi('/v1/keys', {
      method: 'POST',
      headers: { 'X-Admin-Secret': ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: '{"name":"inf","rate_per_min":1e999}',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a name over 128 chars with 400', async () => {
    const res = await fetchApi('/v1/keys', {
      method: 'POST',
      headers: { 'X-Admin-Secret': ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'n'.repeat(200) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_name');
  });

  it('defaults rate_per_min to 60 when omitted', async () => {
    const res = await fetchApi('/v1/keys', {
      method: 'POST',
      headers: { 'X-Admin-Secret': ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'default-rate' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { rate_per_min: number };
    expect(body.rate_per_min).toBe(60);
  });

  it('rejects a wrong admin secret with 403', async () => {
    const res = await fetchApi('/v1/keys', {
      method: 'POST',
      headers: { 'X-Admin-Secret': 'wrong' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a missing admin secret with 403', async () => {
    const res = await fetchApi('/v1/keys', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
