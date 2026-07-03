import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { seededClient } from './helpers';
import type { StreamDO } from '../src/do/stream';
import { genesisHash, nextHash } from '../src/lib/hash';

// Regression: a retried Idempotency-Key must bind the read-model row to the
// ORIGINAL event (whose payload hashes to the stored hash), never to the
// retried request body — even in the self-heal window where the first mirror
// write never landed.
describe('read-model integrity on idempotent replay', () => {
  it('mirrors the original payload (matching the stored hash), not a retried body', async () => {
    const api = await seededClient();
    const id = await api.createStream();

    // Simulate "DO committed, D1 mirror failed": write the event straight to the
    // Durable Object so no `events` row exists yet.
    const ns = env.STREAM as unknown as DurableObjectNamespace<StreamDO>;
    const stub = ns.get(ns.idFromName(id));
    const original = { amount: 100, currency: 'USD' };
    const first = await stub.append(original, 'dup-key');

    // Client retries the SAME key with a DIFFERENT body via the route. This is
    // the first time a row gets mirrored (no PK collision protects it).
    const replay = await api.append(id, { amount: 999, currency: 'EUR' }, 'dup-key');
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');

    const body = (await (
      await api.fetch(`/v1/streams/${id}/events`)
    ).json()) as { events: { seq: number; hash: string; payload: unknown }[] };
    const event = body.events.find((e) => e.seq === first.seq)!;

    // The mirrored payload must be the original, and must hash to the stored
    // hash under the public chain rule.
    expect(event.payload).toEqual(original);
    const recomputed = await nextHash(
      await genesisHash(id),
      event.payload,
      event.seq,
    );
    expect(recomputed).toBe(event.hash);
  });

  // The DO is authoritative and its commit is durable; D1 is an eventually-
  // consistent projection. A failed mirror write therefore must not turn a
  // successful append into a 500 — the client would never learn its {seq, hash}
  // even though the event exists.
  it('append still succeeds when the D1 mirror write fails', async () => {
    const api = await seededClient();
    const id = await api.createStream();

    // Simulate a D1 outage for the mirror INSERT. Isolated per-test storage
    // restores the table for every other test.
    await env.DB.exec('DROP TABLE events;');

    const res = await api.append(id, { amount: 42 }, 'mirror-fail-1');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { seq: number; hash: string };
    expect(body.seq).toBe(1);
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);

    // The authoritative write landed.
    const head = (await (await api.fetch(`/v1/streams/${id}/head`)).json()) as {
      count: number;
    };
    expect(head.count).toBe(1);
  });
});
