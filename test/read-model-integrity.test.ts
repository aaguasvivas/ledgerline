import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import { seededClient } from './helpers';
import type { StoredEvent, StreamDO } from '../src/do/stream';
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
  await env.DB.exec('DROP TRIGGER IF EXISTS count_attempts;');
  await env.DB.exec('DROP TABLE IF EXISTS insert_attempts;');
}

/** Record the seq of every INSERT attempted on the read model, ignored or not. */
async function countInsertAttempts(): Promise<() => Promise<number[]>> {
  await env.DB.exec('CREATE TABLE insert_attempts (seq INTEGER NOT NULL);');
  await env.DB.exec(
    'CREATE TRIGGER count_attempts BEFORE INSERT ON events BEGIN INSERT INTO insert_attempts VALUES (NEW.seq); END;',
  );
  return async () =>
    (await env.DB.prepare('SELECT seq FROM insert_attempts ORDER BY seq').all<{ seq: number }>())
      .results.map((r) => r.seq);
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

  it('works through a backlog larger than one sweep, in order, with no gaps', async () => {
    const api = await seededClient();
    const id = await api.createStream();
    const stub = streamStub(id);
    // Appending to the DO directly skips the Worker's inline mirror, so the
    // outbox is the only path into D1 for all 150 events.
    for (let i = 1; i <= 150; i++) await stub.append({ i }, `k-${i}`);

    // Each sweep stays inside its D1 query budget, so this takes several.
    expect(await drainOutbox(stub)).toBeGreaterThan(1);
    expect((await readEvents(api, id)).map((e) => e.seq)).toEqual(
      Array.from({ length: 150 }, (_, i) => i + 1),
    );
  });

  // Catching up must not re-send what the inline path already delivered:
  // after a long outage that is the difference between a handful of inserts
  // and one per event since the watermark.
  it('inserts only the rows D1 is missing', async () => {
    const api = await seededClient();
    const id = await api.createStream();
    for (let i = 1; i <= 10; i++) await api.append(id, { i }, `k-${i}`);
    // Two inline writes "never landed".
    await env.DB.prepare('DELETE FROM events WHERE stream_id = ? AND seq IN (3, 7)').bind(id).run();
    const attempts = await countInsertAttempts();

    await drainOutbox(streamStub(id));

    expect(await attempts()).toEqual([3, 7]);
    expect((await readEvents(api, id)).map((e) => e.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
  });

  // Regression: a page used to return every row D1 held, so with seq 2 still
  // in the outbox a tailing reader got [1, 3], moved its cursor to 3, and never
  // saw seq 2 even after the outbox delivered it.
  it('ends a page before a seq the read model has not received yet', async () => {
    const api = await seededClient();
    const id = await api.createStream();
    // Only seq 2's inline mirror fails; seq 1 and seq 3 land in D1.
    await env.DB.exec(
      "CREATE TRIGGER outage BEFORE INSERT ON events WHEN NEW.seq = 2 BEGIN SELECT RAISE(ABORT, 'simulated'); END;",
    );
    for (let i = 1; i <= 3; i++) {
      expect((await api.append(id, { i }, `k-${i}`)).status).toBe(201);
    }

    expect((await readEvents(api, id)).map((e) => e.seq)).toEqual([1]);

    await restoreReadModel();
    await drainOutbox(streamStub(id));
    const next = (await (await api.fetch(`/v1/streams/${id}/events?after=1`)).json()) as {
      events: ReadEvent[];
    };
    expect(next.events.map((e) => e.seq)).toEqual([2, 3]);
  });

  // Regression: the watermark used to advance by each stored event's own seq
  // field, so one damaged event made every sweep redo the same work forever.
  it('cannot be stalled by a damaged or missing event', async () => {
    const api = await seededClient();
    const id = await api.createStream();
    const stub = streamStub(id);
    for (let i = 1; i <= 4; i++) await stub.append({ i }, `k-${i}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const events = await state.storage.list<StoredEvent>({ prefix: 'event:' });
      for (const [key, event] of events) {
        if (event.seq === 2) await state.storage.delete(key);
        if (event.seq === 3) await state.storage.put(key, { ...event, seq: 1 });
      }
    });

    await drainOutbox(stub); // throws if it does not converge
    // Pages stop at the hole the authority itself lost (verify names it); a
    // reader moves past it only by asking for after=3 explicitly.
    expect((await readEvents(api, id)).map((e) => e.seq)).toEqual([1]);
    const past = (await (await api.fetch(`/v1/streams/${id}/events?after=3`)).json()) as {
      events: ReadEvent[];
    };
    expect(past.events.map((e) => e.seq)).toEqual([4]);
    expect(await stub.verify()).toEqual({ valid: false, brokenAt: 2 });
  });

  // Regression: a stored event missing its payload or hash made every sweep's
  // batch throw, so the sweep retried the same batch forever and its intact
  // neighbours never reached D1; and a damaged seq field let an event claim
  // another seq's row, permanently shadowing the real event there.
  it('skips damaged events without stalling, and never lets one take another row', async () => {
    const api = await seededClient();
    const id = await api.createStream();
    const stub = streamStub(id);
    for (let i = 1; i <= 5; i++) await stub.append({ i }, `k-${i}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const events = await state.storage.list<StoredEvent>({ prefix: 'event:' });
      for (const [key, event] of events) {
        if (event.seq === 2) {
          const { payload: _payload, ...rest } = event;
          await state.storage.put(key, rest);
        }
        if (event.seq === 3) await state.storage.put(key, { ...event, seq: 7 });
        if (event.seq === 4) {
          const { hash: _hash, ...rest } = event;
          await state.storage.put(key, rest);
        }
      }
    });
    const rows = async () =>
      (await env.DB.prepare('SELECT seq, payload FROM events WHERE stream_id = ? ORDER BY seq')
        .bind(id)
        .all<{ seq: number; payload: string }>()).results;

    await drainOutbox(stub); // throws if it does not converge
    expect((await rows()).map((r) => r.seq)).toEqual([1, 5]);

    // Seq 7 belongs to the real seventh event, not to damaged event 3.
    for (const i of [6, 7]) expect((await api.append(id, { i }, `k-${i}`)).status).toBe(201);
    await drainOutbox(stub);
    expect(await rows()).toEqual([
      { seq: 1, payload: '{"i":1}' },
      { seq: 5, payload: '{"i":5}' },
      { seq: 6, payload: '{"i":6}' },
      { seq: 7, payload: '{"i":7}' },
    ]);
    expect(await stub.verify()).toEqual({ valid: false, brokenAt: 2 });
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
