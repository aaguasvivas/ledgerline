import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * An error that maps cleanly to an HTTP response. Throw it from any handler or
 * middleware; the app's `onError` renders it as `{ error: { code, message } }`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The canonical error envelope returned by every endpoint. */
export function errorBody(code: string, message: string) {
  return { error: { code, message } } as const;
}
