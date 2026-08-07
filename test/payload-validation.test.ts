import { describe, it, expect, beforeEach } from 'vitest';
import { seededClient } from './helpers';

let api: Awaited<ReturnType<typeof seededClient>>;
let streamId: string;

beforeEach(async () => {
  api = await seededClient();
  streamId = await api.createStream();
});

/** Send a raw body string to the append route. */
function appendRaw(body: string, idempotencyKey = crypto.randomUUID()) {
  return api.fetch(`/v1/streams/${streamId}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body,
  });
}

describe('payload limits', () => {
  it('rejects a body over 256 KiB with a typed 413', async () => {
    const res = await appendRaw(JSON.stringify({ data: 'x'.repeat(270_000) }));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('payload_too_large');
  });

  it('rejects nesting deeper than 64 levels with a typed 400', async () => {
    // 100-deep array: parses fine, but must not reach the recursive hasher.
    const res = await appendRaw('['.repeat(100) + '1' + ']'.repeat(100));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('payload_too_deep');
  });

  it('rejects non-finite numbers (JSON 1e999 parses to Infinity) with 400', async () => {
    // Without the check this is silently canonicalized as null, a
    // type-changing mutation and a hash collision with a literal null.
    const res = await appendRaw('{"amount":1e999}');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_payload');
  });

  it('rejects an Idempotency-Key longer than 256 chars with 400', async () => {
    const res = await appendRaw('{"a":1}', 'k'.repeat(300));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_key_invalid');
  });

  it('still accepts reasonable payloads (10-deep nesting, 100 KiB body)', async () => {
    const nested = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } };
    const ok1 = await appendRaw(JSON.stringify(nested));
    expect(ok1.status).toBe(201);

    const ok2 = await appendRaw(JSON.stringify({ data: 'y'.repeat(100_000) }));
    expect(ok2.status).toBe(201);
  });
});
