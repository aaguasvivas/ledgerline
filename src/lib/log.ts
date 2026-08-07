/**
 * Minimal structured logger: one JSON object per line, consumable by
 * `wrangler tail` and Workers observability. Kept tiny on purpose: no
 * dependencies, no buffering.
 */
type Fields = Record<string, unknown>;

function emit(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Fields,
): void {
  const line = JSON.stringify({ level, event, ts: Date.now(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: Fields = {}) => emit('info', event, fields),
  warn: (event: string, fields: Fields = {}) => emit('warn', event, fields),
  error: (event: string, fields: Fields = {}) => emit('error', event, fields),
};
