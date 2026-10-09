import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { fetchApi } from './helpers';
import { DEMO_EVENTS, DEMO_STREAM_ID } from '../src/worker/landing';
import type { StreamDO } from '../src/do/stream';

describe('GET /', () => {
  it('serves the landing page with the interactive chain', async () => {
    const res = await fetchApi('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<title>Ledgerline');
    expect(html).toContain('id="chain"');
    for (const ev of DEMO_EVENTS) expect(html).toContain(`id="block-${ev.seq}"`);
    expect(html).toContain('https://adelsonaguasvivas.com');
  });

  it('points Open Graph tags at absolute URLs on the requesting origin', async () => {
    const html = await (await fetchApi('/')).text();
    expect(html).toContain('<meta property="og:image" content="https://ledgerline.test/og.png">');
    expect(html).toContain('<meta property="og:url" content="https://ledgerline.test/">');
  });

  // The page recomputes these hashes in the visitor's browser and claims they
  // match the API byte for byte. Replaying the same events through a real
  // StreamDO keeps that claim true if the hash rule ever changes.
  it('embeds a recorded chain that the server reproduces byte for byte', async () => {
    const ns = env.STREAM as unknown as DurableObjectNamespace<StreamDO>;
    const stub = ns.get(ns.idFromName(DEMO_STREAM_ID));
    await stub.create(DEMO_STREAM_ID);

    for (const ev of DEMO_EVENTS) {
      const result = await stub.append(ev.payload, ev.idempotencyKey);
      expect(result).toMatchObject({ status: 'created', seq: ev.seq, hash: ev.hash });
    }
    expect(await stub.verify()).toEqual({ valid: true });
  });
});

describe('GET /og.png', () => {
  it('serves the social preview card as a PNG', async () => {
    const res = await fetchApi('/og.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
