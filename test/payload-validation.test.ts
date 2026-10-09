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

  // Regression: the body used to be buffered in full before its size was
  // checked. A large chunked body (no Content-Length) separates the two
  // behaviours by how much of it the server pulls: a streaming cap stops near
  // 256 KiB, while buffer-then-check drains all 8 MiB before answering 413.
  it('stops reading an oversized chunked body (no Content-Length) at the cap', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(65_536));
    const total = 8 * 1024 * 1024;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":"'));
      },
      pull(controller) {
        if (pulled >= total) return controller.close();
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const res = await api.fetch(`/v1/streams/${streamId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'chunked' },
      body,
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('payload_too_large');
    expect(pulled).toBeLessThan(total / 2);
  });

  it('rejects a body that is not valid UTF-8 instead of silently replacing bytes', async () => {
    const bytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]); // {"a":"<0xFF>"}
    const res = await api.fetch(`/v1/streams/${streamId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'bad-utf8' },
      body: bytes,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('invalid_payload');
  });

  // An escaped lone surrogate is legal JSON text (and valid UTF-8 on the wire)
  // but not valid Unicode, and has no RFC 8785 canonical form, so external
  // verifiers could disagree. The source holds a doubled backslash so the
  // request body carries the six-character JSON escape, not a raw code unit.
  it('rejects unpaired UTF-16 surrogates in values and keys', async () => {
    for (const raw of ['{"a":"\\ud800"}', '{"\\udc00":1}', '["ok", "x\\ud83d"]', '"\\ude80\\ud83d"']) {
      const res = await appendRaw(raw);
      expect(res.status, raw).toBe(400);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe('invalid_payload');
    }
    // A well-formed surrogate PAIR (an astral character) is fine.
    expect((await appendRaw('{"a":"\\ud83d\\ude80"}')).status).toBe(201);
  });

  it('still accepts reasonable payloads (10-deep nesting, 100 KiB body)', async () => {
    const nested = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } };
    const ok1 = await appendRaw(JSON.stringify(nested));
    expect(ok1.status).toBe(201);

    const ok2 = await appendRaw(JSON.stringify({ data: 'y'.repeat(100_000) }));
    expect(ok2.status).toBe(201);
  });
});
