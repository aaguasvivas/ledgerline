import { env } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import { seededClient } from './helpers';
import type { StreamDO } from '../src/do/stream';
import { genesisHash, nextHash } from '../src/lib/hash';

type Api = Awaited<ReturnType<typeof seededClient>>;
interface ReadEvent {
  seq: number;
  hash: string;
  prevHash: string;
  payload: unknown;
}

function streamStub(streamId: string): DurableObjectStub<StreamDO> {
  const ns = env.STREAM as unknown as DurableObjectNamespace<StreamDO>;
  return ns.get(ns.idFromName(streamId));
}

/** Make every INSERT into the read model fail, as a D1 outage would. */
async function breakReadModel(): Promise<void> {
  await env.DB.exec(
    "CREATE TRIGGER outage BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'simulated D1 outage'); END;",
  );
}

async function restoreReadModel(): Promise<void> {
  await env.DB.exec('DROP TRIGGER IF EXISTS outage;');
}

// D1 state is shared by the tests in this file; never leak an outage.
afterEach(restoreReadModel);

async function readEvents(api: Api, id: string): Promise<ReadEvent[]> {
  const res = await api.fetch(`/v1/streams/${id}/events?limit=200`);
  return ((await res.json()) as { events: ReadEvent[] }).events;
}

// The DO is authoritative and its commit is durable; D1 is an eventually-
// consistent projection. A read-model failure must never fail a committed
// write, and the read model must only ever hold authoritative payloads.
describe('read model delivery', () => {
  it('append still succeeds when the inline D1 mirror write fails', async () => {
    const api = await seededClient();
    const id = await api.createStream();
    await breakReadModel();

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

  it('a faithful retry re-mirrors the ORIGINAL event, matching the stored hash', async () => {
    const api = await seededClient();
    const id = await api.createStream();
    // "DO committed, mirror never landed": write straight to the DO.
    const first = await streamStub(id).append({ amount: 100, currency: 'USD' }, 'dup');

    // Same key, same payload re-serialized in another key order.
    const replay = await api.fetch(`/v1/streams/${id}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'dup' },
      body: '{"currency":"USD","amount":100}',
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');

    const [event] = await readEvents(api, id);
    expect(event).toMatchObject({ seq: first.seq, payload: { amount: 100, currency: 'USD' } });
    expect(await nextHash(await genesisHash(id), event.payload, event.seq)).toBe(event.hash);
  });

  // Regression: a retry with a DIFFERENT body used to be answered with the
  // original {seq, hash} as a success, so a client that reused a key by
  // mistake believed a write happened that never did.
  it('rejects a reused key with a different payload: 422, nothing written', async () => {
    const api = await seededClient();
    const id = await api.createStream();
    expect((await api.append(id, { amount: 100 }, 'inv-1')).status).toBe(201);

    const res = await api.append(id, { amount: 99999 }, 'inv-1');
    expect(res.status).toBe(422);
    expect(res.headers.get('Idempotent-Replay')).toBeNull();
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_key_reused');

    const events = await readEvents(api, id);
    expect(events.map((e) => e.payload)).toEqual([{ amount: 100 }]);
    const head = (await (await api.fetch(`/v1/streams/${id}/head`)).json()) as {
      count: number;
    };
    expect(head.count).toBe(1);
  });
});
