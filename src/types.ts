/** Region base URLs named on docs.coderabbit.ai. The spec itself lists only the US server. */
export const BASE_URLS = {
  us: 'https://api.coderabbit.ai',
  eu: 'https://api.eu.coderabbit.ai',
} as const;

export type Region = keyof typeof BASE_URLS;

/**
 * Organization selector for workspace API keys. Organization keys select their
 * own organization and should omit it. The docs say to supply only one of the two.
 */
export type OrgSelector = { org_name: string; org_id?: never } | { org_id: string; org_name?: never };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** API key sent as `x-coderabbitai-api-key`. Defaults to the CODERABBIT_API_KEY environment variable. */
  apiKey?: string;
  /** `us` (default) or `eu`. Ignored when `baseUrl` is set. */
  region?: Region;
  /** Full origin override, for example a proxy. Operation paths already start with `/v1` or `/api/v1`. */
  baseUrl?: string;
  /** Default organization selector, added to every operation that accepts one (query or JSON body, as the spec places it). */
  org?: OrgSelector;
  /** Custom fetch implementation. Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Per-attempt timeout in milliseconds. Default 60000. `report-generate` defaults to 600000 because the spec says it can take up to 10 minutes. */
  timeoutMs?: number;
  /** Retries after the first attempt for 429, 5xx and network errors. Default 2. */
  maxRetries?: number;
  /** Longest single wait before a retry. A longer Retry-After stops retrying and throws. Default 60000. */
  maxRetryDelayMs?: number;
  /** Starting backoff when the server gives no Retry-After. Doubles per attempt, with jitter. Default 500. */
  baseRetryDelayMs?: number;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Replaces the wait between retries. Meant for tests and custom schedulers. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
  /**
   * Allow retrying POST and PATCH after a 5xx or network error. Off by default,
   * because those requests may have been applied. 429 is always retried.
   * Operations whose body carries a `client_operation_id` are retried when one is supplied.
   */
  retryUnsafe?: boolean;
}

export interface ResponseMeta {
  status: number;
  headers: Headers;
  url: string;
  attempts: number;
}

export interface PaginationOptions extends RequestOptions {
  /** Stop after this many pages. */
  maxPages?: number;
}
