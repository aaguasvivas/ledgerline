import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { seededClient } from './helpers';
import type { StreamDO } from '../src/do/stream';

// D1 unreachable: every /v1/streams route resolves the bearer key in D1 before
// it calls a Durable Object, so when that lookup fails the request ends in a
// 500 and the authoritative log is never written. Dropping api_keys stands in
// for the outage; each test file has its own isolated storage, so this cannot
// leak into other files.
describe('D1 unavailable', () => {
  it('fails an append with 500 when the key lookup fails, and writes nothing', async () => {
    const api = await seededClient();
    const id = await api.createStream();
    expect((await api.append(id, { n: 1 }, 'k-1')).status).toBe(201);

    await env.DB.exec('DROP TABLE api_keys;');

    const res = await api.append(id, { n: 2 }, 'k-2');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('internal_error');

    const ns = env.STREAM as unknown as DurableObjectNamespace<StreamDO>;
    expect((await ns.get(ns.idFromName(id)).head()).count).toBe(1);
  });
});
