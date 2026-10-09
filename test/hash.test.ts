import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  sha256Hex,
  genesisHash,
  nextHash,
} from '../src/lib/hash';

describe('canonicalize', () => {
  it('sorts object keys recursively and emits no whitespace', () => {
    const input = { b: 1, a: { d: 4, c: 3 }, arr: [3, { z: 1, y: 2 }] };
    expect(canonicalize(input)).toBe(
      '{"a":{"c":3,"d":4},"arr":[3,{"y":2,"z":1}],"b":1}',
    );
  });

  it('preserves array order while canonicalizing elements', () => {
    expect(canonicalize([{ b: 2, a: 1 }, 'x', 3])).toBe('[{"a":1,"b":2},"x",3]');
  });

  it('handles primitives and null', () => {
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('hi')).toBe('"hi"');
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
  });

  // Regression: JSON.parse creates "__proto__" as an OWN property, and a naive
  // rebuild onto {} triggers the prototype setter instead, silently dropping
  // the key from the canonical form (hash collision + data loss).
  it('preserves own "__proto__" keys from JSON.parse', () => {
    const withProto = JSON.parse('{"__proto__":{"a":1},"b":2}');
    expect(canonicalize(withProto)).toBe('{"__proto__":{"a":1},"b":2}');
    // Round-trip stable: canonicalizing the canonical form is a fixed point.
    expect(canonicalize(JSON.parse(canonicalize(withProto)))).toBe(
      '{"__proto__":{"a":1},"b":2}',
    );
  });

  it('hashes payloads that differ only in "__proto__" content differently', async () => {
    const g = await genesisHash('s');
    const a = await nextHash(g, JSON.parse('{"__proto__":{"x":1},"b":2}'), 1);
    const b = await nextHash(g, JSON.parse('{"__proto__":{"x":2},"b":2}'), 1);
    const c = await nextHash(g, JSON.parse('{"b":2}'), 1);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

// RFC 8785 (JSON Canonicalization Scheme) is the published contract for
// external verifiers, so its own worked examples are the conformance suite.
describe('RFC 8785 conformance', () => {
  it('sorts keys by UTF-16 code units, integer-like keys included (RFC 8785 sec. 3.2.3)', () => {
    const input = JSON.parse(`{
      "\\u20ac": "Euro Sign",
      "\\r": "Carriage Return",
      "\\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\\ud83d\\ude00": "Emoji: Grinning Face",
      "\\u0080": "Control",
      "\\u00f6": "Latin Small Letter O With Diaeresis"
    }`);
    // Read member values off the serialized string: re-parsing it into an
    // object would let the engine reorder the integer-like key again.
    const values = [...canonicalize(input).matchAll(/:"([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual([
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ]);
  });

  // Regression: canonicalize used to stringify a re-sorted object, and engines
  // enumerate integer-like keys first in numeric order, so "9" preceded "10"
  // and "1" preceded "\r", diverging from the documented spec.
  it('orders integer-like keys as strings, not numbers', () => {
    expect(canonicalize({ b: 0, 10: 1, 9: 2, '-1': 3 })).toBe(
      '{"-1":3,"10":1,"9":2,"b":0}',
    );
  });

  it('formats numbers and escapes strings as specified (RFC 8785 sec. 3.2.4)', () => {
    const input = JSON.parse(String.raw`{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
      "literals": [null, true, false]
    }`);
    expect(canonicalize(input)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
  });
});

describe('canonical unicode contract', () => {
  // External verifiers must reproduce these bytes exactly. JS JSON.stringify
  // emits non-ASCII unescaped (unlike e.g. Python's ensure_ascii default);
  // this pin makes any change to string serialization a loud test failure,
  // because it would silently re-hash every existing chain.
  it('emits non-ASCII characters unescaped [known answer]', () => {
    expect(canonicalize({ m: 'héllo 🚀', cjk: '分散台帳' })).toBe(
      '{"cjk":"分散台帳","m":"héllo 🚀"}',
    );
  });

  it('hashes a unicode payload to a pinned vector [known answer]', async () => {
    const g = await genesisHash('unicode-stream');
    expect(await nextHash(g, { m: 'héllo 🚀', cjk: '分散台帳' }, 1)).toBe(
      'adcc8b06f64d591edb552cefce45aa6bb423eb97090a9de6b451d17d57352d5f',
    );
  });
});

describe('sha256Hex', () => {
  it('produces lowercase 64-char hex', async () => {
    expect(await sha256Hex('ledgerline')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('genesisHash', () => {
  it('equals SHA-256("ledgerline:v1:" + streamId) [known answer]', async () => {
    expect(await genesisHash('stream-abc')).toBe(
      '28f6850ebf448fdfda80dab7f4c03eaee21061732bcfae3abf1be42049820a39',
    );
  });
});

describe('nextHash', () => {
  it('chains hash_n = SHA-256(prev | canonicalJSON(payload) | seq) [known answer]', async () => {
    const genesis = await genesisHash('stream-abc');
    const h1 = await nextHash(genesis, { amount: 100, currency: 'USD' }, 1);
    expect(h1).toBe(
      '7e563267db3692dbf52e2ac9952eac0ef6c0014744993dd07adecdb2451ac91e',
    );
    const h2 = await nextHash(h1, { note: 'second' }, 2);
    expect(h2).toBe(
      '174d9bbc5b460f17e0ffd490a245adadbe6754c8c4255672527ce250f22575ea',
    );
  });

  it('is sensitive to prevHash, payload, and seq', async () => {
    const g = await genesisHash('s');
    const base = await nextHash(g, { a: 1 }, 1);
    expect(await nextHash(g, { a: 2 }, 1)).not.toBe(base);
    expect(await nextHash(g, { a: 1 }, 2)).not.toBe(base);
    expect(await nextHash('different', { a: 1 }, 1)).not.toBe(base);
  });
});
