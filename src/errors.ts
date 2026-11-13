/**
 * The spec uses three error body shapes:
 *   shared Platform API operations   { "error": { "code", "message", "retry_after"? } }
 *   older report and metrics routes  { "errors": [ { "code", "message" } ] }
 *   a few examples                   { "code", "message" }
 * CodeRabbitApiError reads all three.
 */
export type ErrorBody =
  | { error: { code: string; message: string; retry_after?: number } }
  | { errors: Array<{ code?: string; message?: string }> }
  | { code?: string; message?: string };

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  reset?: number;
}

export interface ApiErrorInit {
  status: number;
  statusText: string;
  body: unknown;
  rawBody: string;
  headers: Headers;
  method: string;
  url: string;
  operationId: string;
  attempts: number;
}

export class CodeRabbitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CodeRabbitError';
  }
}

function num(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Parses a Retry-After header (delta seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pulls code, message and retry_after out of any of the documented error shapes. */
export function readErrorBody(body: unknown): { code?: string; message?: string; retryAfterSeconds?: number } {
  if (!isObject(body)) return {};
  const inner = body.error;
  if (isObject(inner)) {
    return {
      code: typeof inner.code === 'string' ? inner.code : undefined,
      message: typeof inner.message === 'string' ? inner.message : undefined,
      retryAfterSeconds: typeof inner.retry_after === 'number' ? inner.retry_after : undefined,
    };
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    const messages = body.errors
      .map((e: unknown) => (isObject(e) && typeof e.message === 'string' ? e.message : undefined))
      .filter((m): m is string => m !== undefined);
    return {
      code: isObject(first) && typeof first.code === 'string' ? first.code : undefined,
      message: messages.length ? messages.join('; ') : undefined,
    };
  }
  return {
    code: typeof body.code === 'string' ? body.code : undefined,
    message: typeof body.message === 'string' ? body.message : typeof inner === 'string' ? inner : undefined,
  };
}

/** A non-2xx response. `body` is the parsed JSON when the server sent JSON, otherwise the raw text. */
export class CodeRabbitApiError extends CodeRabbitError {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;
  readonly rawBody: string;
  readonly headers: Headers;
  readonly method: string;
  readonly url: string;
  readonly operationId: string;
  readonly attempts: number;
  /** Server-requested wait in milliseconds, from Retry-After or error.retry_after. */
  readonly retryAfterMs: number | undefined;
  readonly rateLimit: RateLimitInfo | undefined;
  readonly requestId: string | undefined;

  constructor(init: ApiErrorInit) {
    const parsed = readErrorBody(init.body);
    const fallback = init.rawBody && init.rawBody.length <= 300 && !isObject(init.body) ? init.rawBody.trim() : init.statusText;
    const message = parsed.message || fallback || `HTTP ${init.status}`;
    super(`${init.method} ${new URL(init.url).pathname} failed with ${init.status}${parsed.code ? ` ${parsed.code}` : ''}: ${message}`);
    this.name = 'CodeRabbitApiError';
    this.status = init.status;
    this.code = parsed.code;
    this.body = init.body;
    this.rawBody = init.rawBody;
    this.headers = init.headers;
    this.method = init.method;
    this.url = init.url;
    this.operationId = init.operationId;
    this.attempts = init.attempts;
    const header = parseRetryAfter(init.headers.get('retry-after'));
    this.retryAfterMs = header ?? (parsed.retryAfterSeconds !== undefined ? parsed.retryAfterSeconds * 1000 : undefined);
    const limit = num(init.headers.get('x-ratelimit-limit'));
    const remaining = num(init.headers.get('x-ratelimit-remaining'));
    const reset = num(init.headers.get('x-ratelimit-reset'));
    this.rateLimit = limit !== undefined || remaining !== undefined || reset !== undefined ? { limit, remaining, reset } : undefined;
    this.requestId = init.headers.get('x-request-id') ?? undefined;
  }

  /** The error message the server sent, without the request prefix. */
  get serverMessage(): string | undefined {
    return readErrorBody(this.body).message;
  }
}

export class CodeRabbitBadRequestError extends CodeRabbitApiError {
  constructor(init: ApiErrorInit) {
    super(init);
    this.name = 'CodeRabbitBadRequestError';
  }
}
export class CodeRabbitAuthenticationError extends CodeRabbitApiError {
  constructor(init: ApiErrorInit) {
    super(init);
    this.name = 'CodeRabbitAuthenticationError';
  }
}
export class CodeRabbitPaymentRequiredError extends CodeRabbitApiError {
  constructor(init: ApiErrorInit) {
    super(init);
    this.name = 'CodeRabbitPaymentRequiredError';
  }
}
export class CodeRabbitPermissionError extends CodeRabbitApiError {
  constructor(init: ApiErrorInit) {
    super(init);
    this.name = 'CodeRabbitPermissionError';
  }
}
export class CodeRabbitNotFoundError extends CodeRabbitApiError {
  constructor(init: ApiErrorInit) {
    super(init);
    this.name = 'CodeRabbitNotFoundError';
  }
}
export class CodeRabbitConflictError extends CodeRabbitApiError {
  constructor(init: ApiErrorInit) {
    super(init);
    this.name = 'CodeRabbitConflictError';
  }
}
export class CodeRabbitGoneError extends CodeRabbitApiError {
  constructor(init: ApiErrorInit) {
    super(init);
    this.name = 'CodeRabbitGoneError';
  }
}
export class CodeRabbitRateLimitError extends CodeRabbitApiError {
  constructor(init: ApiErrorInit) {
    super(init);
    this.name = 'CodeRabbitRateLimitError';
  }
}
export class CodeRabbitServerError extends CodeRabbitApiError {
  constructor(init: ApiErrorInit) {
    super(init);
    this.name = 'CodeRabbitServerError';
  }
}

export function createApiError(init: ApiErrorInit): CodeRabbitApiError {
  switch (init.status) {
    case 400:
    case 413:
      return new CodeRabbitBadRequestError(init);
    case 401:
      return new CodeRabbitAuthenticationError(init);
    case 402:
      return new CodeRabbitPaymentRequiredError(init);
    case 403:
      return new CodeRabbitPermissionError(init);
    case 404:
      return new CodeRabbitNotFoundError(init);
    case 409:
    case 412:
      return new CodeRabbitConflictError(init);
    case 410:
      return new CodeRabbitGoneError(init);
    case 429:
      return new CodeRabbitRateLimitError(init);
    default:
      return init.status >= 500 ? new CodeRabbitServerError(init) : new CodeRabbitApiError(init);
  }
}

/** The request did not finish within `timeoutMs`. */
export class CodeRabbitTimeoutError extends CodeRabbitError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, url: string) {
    super(`Request to ${new URL(url).pathname} timed out after ${timeoutMs} ms`);
    this.name = 'CodeRabbitTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** fetch itself failed (DNS, TLS, connection reset). The original error is in `cause`. */
export class CodeRabbitConnectionError extends CodeRabbitError {
  constructor(url: string, cause: unknown) {
    super(`Request to ${new URL(url).pathname} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'CodeRabbitConnectionError';
  }
}
