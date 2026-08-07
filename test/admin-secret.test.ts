import { describe, it, expect } from 'vitest';
import { verifyAdminSecret } from '../src/lib/auth';

// Regression: the admin guard must fail CLOSED. If the secret is unconfigured,
// no request may pass, including one that simply omits the header (which would
// otherwise be `undefined === undefined`).
describe('verifyAdminSecret', () => {
  it('rejects when the expected secret is unconfigured', () => {
    expect(verifyAdminSecret('anything', undefined)).toBe(false);
    expect(verifyAdminSecret(undefined, undefined)).toBe(false);
    expect(verifyAdminSecret('', '')).toBe(false);
  });

  it('rejects a missing or wrong provided secret', () => {
    expect(verifyAdminSecret(undefined, 'secret')).toBe(false);
    expect(verifyAdminSecret('wrong', 'secret')).toBe(false);
    expect(verifyAdminSecret('secre', 'secret')).toBe(false);
  });

  it('accepts an exact match', () => {
    expect(verifyAdminSecret('s3cr3t', 's3cr3t')).toBe(true);
  });
});
