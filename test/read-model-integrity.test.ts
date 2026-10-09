import { env, runDurableObjectAlarm } from 'cloudflare:test';
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

/**
 * Run the stream's outbox sweeps until none is pending. Bounded, because a
 * sweep that fails reschedules itself by design and would otherwise loop.
 */
async function drainOutbox(stub: DurableObjectStub<StreamDO>): Promise<number> {
  let sweeps = 0;
  while (await runDurableObjectAlarm(stub)) {
    if (++sweeps > 10) throw new Error('outbox did not converge');
  }
  return sweeps;
}

// The DO is authoritative and its commit is durable; D1 is an eventually-
// consistent projection. These tests pin both halves of that contract: a
// read-model failure never fails a committed write, and the read model always
// converges on the authoritative log afterwards.
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

  // Regression: a failed inline mirror used to leave a permanent hole in the
  // read model unless the client happened to retry the same key, which it has
  // no reason to do after receiving a 201.
  it('the outbox alarm delivers an event whose inline mirror failed', async () => {
    const api = await seededClient();
    const id = await api.createStream();
    await breakReadModel();
    const appended = (await (
      await api.append(id, { amount: 42 }, 'k1')
    ).json()) as { seq: number; hash: string };
    expect(await readEvents(api, id)).toEqual([]);

    await restoreReadModel();
    await drainOutbox(streamStub(id));

    const [event] = await readEvents(api, id);
    expect(event).toMatchObject({ seq: 1, hash: appended.hash, payload: { amount: 42 } });
    // The delivered row is auditable: it recomputes to the stored hash.
    expect(await nextHash(await genesisHash(id), event.payload, 1)).toBe(event.hash);
  });

  it('keeps retrying through a sustained outage, then converges', async () => {
    const api = await seededClient();
    const id = await api.createStream();
    const stub = streamStub(id);
    await breakReadModel();
    await api.append(id, { n: 1 }, 'k1');

    // A sweep during the outage fails, and must reschedule itself rather than
    // give up (platform alarm retries are finite; this outage might not be).
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await readEvents(api, id)).toEqual([]);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await restoreReadModel();
    await drainOutbox(stub);
    expect((await readEvents(api, id)).map((e) => e.seq)).toEqual([1]);
  });

  it('sweeps a backlog larger than one D1 batch, in order, with no gaps', async () => {
    const api = await seededClient();
    const id = await api.createStream();
    const stub = streamStub(id);
    // Appending to the DO directly skips the Worker's inline mirror, so the
    // outbox is the only path into D1 for all 150 events.
    for (let i = 1; i <= 150; i++) await stub.append({ i }, `k-${i}`);

    expect(await drainOutbox(stub)).toBe(1); // one sweep: batches of 100 + 50
    expect((await readEvents(api, id)).map((e) => e.seq)).toEqual(
      Array.from({ length: 150 }, (_, i) => i + 1),
    );
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
