#!/usr/bin/env node
/**
 * Seed an API key directly into D1.
 *
 * Generates a key with the same scheme as the running service (`lk_` + 192 bits
 * of hex), stores only its SHA-256 hash, and prints the raw key once.
 *
 * Usage:
 *   node scripts/seed.mjs [--name <name>] [--rate <perMinute>] [--remote]
 *
 *   --remote   seed the deployed D1 database (default: local Miniflare D1)
 *   --name     human label for the key            (default: "seed-key")
 *   --rate     requests per minute (rate limit)   (default: 120)
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  // A following flag is not a value: `--name --remote` must not create a key
  // literally named "--remote" (while also targeting the remote database).
  if (value === undefined || value.startsWith('--')) {
    if (i >= 0) {
      console.error(`error: ${flag} requires a value`);
      process.exit(1);
    }
    return fallback;
  }
  return value;
}

const remote = process.argv.includes('--remote');
const name = arg('--name', 'seed-key');
const ratePerMin = Number(arg('--rate', '120'));
if (!Number.isInteger(ratePerMin) || ratePerMin < 1) {
  console.error('error: --rate must be a positive integer');
  process.exit(1);
}

const rawKey = 'lk_' + randomBytes(24).toString('hex');
const keyHash = createHash('sha256').update(rawKey, 'utf8').digest('hex');
const createdAt = Date.now();

const safeName = name.replace(/'/g, "''");
const sql = `INSERT INTO api_keys (key_hash, name, rate_per_min, created_at) VALUES ('${keyHash}', '${safeName}', ${ratePerMin}, ${createdAt});`;

execFileSync(
  'npx',
  [
    'wrangler',
    'd1',
    'execute',
    'ledgerline',
    remote ? '--remote' : '--local',
    '--command',
    sql,
  ],
  { stdio: 'inherit' },
);

console.log('\n  API key (shown once; store it securely):\n');
console.log(`    ${rawKey}\n`);
console.log(`  name=${name}  rate_per_min=${ratePerMin}  scope=${remote ? 'remote' : 'local'}\n`);
