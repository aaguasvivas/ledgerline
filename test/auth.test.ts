import { describe, it, expect } from 'vitest';
import { fetchApi, seededClient } from './helpers';

// Spec test 5 — auth.
describe('authentication', () => {
  it('rejects a missing bearer token with 401', async () => {
    const res = await fetchApi('/v1/streams', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('rejects an invalid bearer token with 401', async () => {
    const res = await fetchApi('/v1/streams', {
      method: 'POST',
      headers: { Authorization: 'Bearer lk_not_a_real_key' },
    });
    expect(res.status).toBe(401);
  });

  it('does not leak another key\'s stream: 404, not 403', async () => {
    const alice = await seededClient();
    const bob = await seededClient();

    const streamId = await alice.createStream();

    // Bob owns a valid key but not this stream.
    const res = await bob.fetch(`/v1/streams/${streamId}/head`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('stream_not_found');

    // Alice can read her own stream.
    const ok = await alice.fetch(`/v1/streams/${streamId}/head`);
    expect(ok.status).toBe(200);
  });
});

describe('/health', () => {
  it('is open (no auth required)', async () => {
    const res = await fetchApi('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
