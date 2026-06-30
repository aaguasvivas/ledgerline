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
