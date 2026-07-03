import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { StreamDO } from '../src/do/stream';

/** Typed handle to a StreamDO instance addressed by stream id. */
function streamStub(streamId: string): DurableObjectStub<StreamDO> {
  const ns = env.STREAM as unknown as DurableObjectNamespace<StreamDO>;
  return ns.get(ns.idFromName(streamId));
}

describe('StreamDO ordering', () => {
  it('assigns strictly increasing, contiguous seq numbers starting at 1', async () => {
    const stub = streamStub('order-stream');
    await stub.create('order-stream');

    const seqs: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await stub.append({ i }, `order-key-${i}`);
      seqs.push(res.seq);
    }

    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));

    const head = await stub.head();
    expect(head.count).toBe(25);

    const verified = await stub.verify();
    expect(verified).toEqual({ valid: true });
  });
});

describe('StreamDO exactly-once (idempotency)', () => {
  it('returns the original result on a repeated key and appends no new event', async () => {
    const stub = streamStub('idem-stream');
    await stub.create('idem-stream');

    const first = await stub.append({ amount: 100 }, 'same-key');
    expect(first.replay).toBe(false);

    const second = await stub.append({ amount: 100 }, 'same-key');
    expect(second.replay).toBe(true);
    expect(second.seq).toBe(first.seq);
    expect(second.hash).toBe(first.hash);

    // Exactly one event exists.
    expect((await stub.head()).count).toBe(1);
  });

  it('treats the key as authoritative: a repeat returns the original even if the payload differs', async () => {
    const stub = streamStub('idem-conflict-stream');
    await stub.create('idem-conflict-stream');

    const first = await stub.append({ v: 'original' }, 'dup');
    const second = await stub.append({ v: 'changed' }, 'dup');

    expect(second.replay).toBe(true);
    expect(second.hash).toBe(first.hash);
    expect((await stub.head()).count).toBe(1);
  });
});

describe('StreamDO hash-chain integrity', () => {
  it('verifies an untampered chain', async () => {
    const stub = streamStub('verify-ok-stream');
    await stub.create('verify-ok-stream');
    for (let i = 0; i < 5; i++) await stub.append({ i }, `ok-${i}`);

    expect(await stub.verify()).toEqual({ valid: true });
  });

  it('detects tampering and reports the first divergent seq', async () => {
    const stub = streamStub('verify-tampered-stream');
    await stub.create('verify-tampered-stream');
    for (let i = 1; i <= 4; i++) await stub.append({ i }, `t-${i}`);

    // Tamper with the stored payload of event seq=2, leaving its hash intact.
    await runInDurableObject(stub, async (_instance, state) => {
      const events = await state.storage.list<{ seq: number; payload: unknown }>(
        { prefix: 'event:' },
      );
      for (const [key, event] of events) {
        if (event.seq === 2) {
          await state.storage.put(key, { ...event, payload: { i: 999 } });
        }
      }
    });

    expect(await stub.verify()).toEqual({ valid: false, brokenAt: 2 });
  });

  // Tail truncation is the classic ledger rollback: deleting the trailing
  // event(s) leaves a chain that recomputes cleanly. verify must compare the
  // recomputed head against meta (count + headHash) to catch it.
  it('detects tail truncation (trailing event deleted, meta intact)', async () => {
    const stub = streamStub('verify-truncated-stream');
    await stub.create('verify-truncated-stream');
    for (let i = 1; i <= 3; i++) await stub.append({ i }, `tr-${i}`);

    await runInDurableObject(stub, async (_instance, state) => {
      const events = await state.storage.list<{ seq: number }>({
        prefix: 'event:',
      });
      for (const [key, event] of events) {
        if (event.seq === 3) await state.storage.delete(key);
      }
    });

    expect(await stub.verify()).toEqual({ valid: false, brokenAt: 3 });
  });

  it('throws for an uninitialized stream, consistent with head()', async () => {
    const stub = streamStub('verify-uninitialized-stream');
    // No create(): meta is absent. A false { valid: true } here would report a
    // vanished authoritative log as a healthy chain.
    // Explicit try/catch: RpcPromise thenables confuse vitest's `.rejects`
    // and leak unhandled-rejection warnings.
    const messages: string[] = [];
    for (const call of [() => stub.verify(), () => stub.head()]) {
      try {
        await call();
      } catch (err) {
        messages.push((err as Error).message);
      }
    }
    expect(messages).toEqual([
      'stream not initialized',
      'stream not initialized',
    ]);
  });
});
