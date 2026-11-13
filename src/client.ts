import { createResources } from './generated/resources.ts';
import type { Resources } from './generated/resources.ts';
import type { OperationId, OperationInputs, OperationOutputs, PageItems, PaginatedOperationId } from './generated/operations.ts';
import { buildRequest, getOperation } from './request.ts';
import type { OperationSpec } from './request.ts';
import { CodeRabbitConnectionError, CodeRabbitError, CodeRabbitTimeoutError, createApiError } from './errors.ts';
import { BASE_URLS } from './types.ts';
import type { ClientOptions, FetchLike, OrgSelector, PaginationOptions, RequestOptions, ResponseMeta } from './types.ts';

export const DEFAULT_TIMEOUT_MS = 60_000;

/** Operations the spec describes as slow. Their default timeout is raised to this value. */
const SLOW_OPERATIONS: Readonly<Record<string, number>> = {
  // "This endpoint may take up to 10 minutes to respond depending on the data volume."
  'report-generate': 600_000,
};

type ArgsFor<K extends OperationId, O> = {} extends OperationInputs[K]
  ? [input?: OperationInputs[K], options?: O]
  : [input: OperationInputs[K], options?: O];

function readEnvKey(): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.CODERABBIT_API_KEY;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readSuccess(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) {
    await response.body?.cancel();
    return undefined;
  }
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('json')) {
    const text = await response.text();
    if (text.trim() === '') return undefined;
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new CodeRabbitError(`Response from ${new URL(response.url || 'http://x/').pathname} is not valid JSON`, { cause });
    }
  }
  if (type.startsWith('text/')) return response.text();
  if (type === '') {
    const text = await response.text();
    if (text === '') return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return response.arrayBuffer();
}

function parseMaybeJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Next page number for page-numbered lists, or undefined when the last page was reached.
 * The spec uses several shapes: pagination.has_next_page, pagination.hasNextPage,
 * pagination.totalPages, nextPage, total and totalCount. An empty page always ends the walk.
 */
export function nextPageNumber(page: unknown, current: number, start: number, seen: number, count: number): number | undefined {
  if (count === 0 || !isObject(page)) return undefined;
  if ('nextPage' in page) return typeof page.nextPage === 'number' ? page.nextPage : undefined;
  const p = page.pagination;
  if (isObject(p)) {
    for (const key of ['has_next_page', 'hasNextPage']) {
      if (typeof p[key] === 'boolean') return p[key] ? current + 1 : undefined;
    }
    const totalPages = typeof p.total_pages === 'number' ? p.total_pages : typeof p.totalPages === 'number' ? p.totalPages : undefined;
    if (totalPages !== undefined) return current - start + 1 < totalPages ? current + 1 : undefined;
  }
  const total = typeof page.total === 'number' ? page.total : typeof page.totalCount === 'number' ? page.totalCount : undefined;
  if (total !== undefined) return seen < total ? current + 1 : undefined;
  return current + 1;
}

/**
 * Client for the CodeRabbit Platform API.
 *
 * Every operation in the spec is available as a namespaced method, for example
 * `client.identity.getMe()`, and also through `client.call(operationId, input)`.
 */
export class CodeRabbit {
  readonly baseUrl: string;
  readonly org: OrgSelector | undefined;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly maxRetryDelayMs: number;
  readonly baseRetryDelayMs: number;
  #apiKey: string;
  #fetch: FetchLike;
  #headers: Record<string, string>;
  #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? readEnvKey();
    if (!apiKey) throw new TypeError('CodeRabbit: apiKey is required (or set CODERABBIT_API_KEY)');
    const region = options.region ?? 'us';
    if (!(region in BASE_URLS)) throw new TypeError(`CodeRabbit: unknown region ${String(region)}`);
    const fetchImpl = options.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchImpl) throw new TypeError('CodeRabbit: no fetch implementation available, pass options.fetch');
    if (options.org && 'org_id' in options.org && 'org_name' in options.org && options.org.org_id !== undefined && options.org.org_name !== undefined) {
      throw new TypeError('CodeRabbit: org takes org_id or org_name, not both');
    }
    this.baseUrl = (options.baseUrl ?? BASE_URLS[region]).replace(/\/+$/, '');
    this.org = options.org;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl as FetchLike;
    this.#headers = { ...(options.headers ?? {}) };
    this.#sleep = options.sleep ?? defaultSleep;
    Object.assign(this, createResources((id, input, opts) => this.#execute(getOperation(id), input as Record<string, unknown> | undefined, opts ?? {}).then((r) => r.data as never)));
  }

  /** Calls any operation by its spec operationId. */
  call<K extends OperationId>(id: K, ...args: ArgsFor<K, RequestOptions>): Promise<OperationOutputs[K]> {
    const [input, options] = args;
    return this.#execute(getOperation(id), input as Record<string, unknown> | undefined, options ?? {}).then((r) => r.data as OperationOutputs[K]);
  }

  /** Same as `call`, plus status, headers, final URL and the number of attempts. */
  async callWithResponse<K extends OperationId>(id: K, ...args: ArgsFor<K, RequestOptions>): Promise<{ data: OperationOutputs[K]; response: ResponseMeta }> {
    const [input, options] = args;
    const r = await this.#execute(getOperation(id), input as Record<string, unknown> | undefined, options ?? {});
    return { data: r.data as OperationOutputs[K], response: r.meta };
  }

  /** Walks every page of a paginated operation, yielding each page body. */
  async *pages<K extends PaginatedOperationId>(id: K, ...args: ArgsFor<K, PaginationOptions>): AsyncGenerator<OperationOutputs[K], void, undefined> {
    const [input, options = {}] = args;
    const op = getOperation(id);
    const p = op.pagination;
    if (!p) throw new TypeError(`${id} is not paginated`);
    const base: Record<string, unknown> = { ...((input ?? {}) as Record<string, unknown>) };
    let state: unknown = base[p.param] ?? (p.kind === 'page' ? p.start : undefined);
    const visited = new Set<string>();
    let count = 0;
    let seen = 0;
    for (;;) {
      const request = { ...base };
      if (state !== undefined) request[p.param] = state;
      const { data } = await this.#execute(op, request, options);
      yield data as OperationOutputs[K];
      count += 1;
      if (options.maxPages !== undefined && count >= options.maxPages) return;
      const body = isObject(data) ? data : {};
      const items = body[p.items];
      const n = Array.isArray(items) ? items.length : 0;
      seen += n;
      if (p.kind === 'cursor') {
        const next = body[p.next];
        if (next === null || next === undefined || next === '') return;
        const key = String(next);
        if (visited.has(key) || key === String(state)) return;
        visited.add(key);
        state = next;
      } else {
        const next = nextPageNumber(body, Number(state), p.start, seen, n);
        if (next === undefined) return;
        state = next;
      }
    }
  }

  /** Walks every page and yields the individual items of each page. */
  async *items<K extends PaginatedOperationId>(id: K, ...args: ArgsFor<K, PaginationOptions>): AsyncGenerator<PageItems[K], void, undefined> {
    const op = getOperation(id);
    const key = op.pagination?.items;
    if (!key) throw new TypeError(`${id} is not paginated`);
    for await (const page of this.pages(id, ...args)) {
      const body: unknown = page;
      const list = isObject(body) ? body[key] : undefined;
      if (Array.isArray(list)) yield* list as PageItems[K][];
    }
  }

  #backoff(attempt: number): number {
    const raw = this.baseRetryDelayMs * 2 ** (attempt - 1);
    const jittered = raw * (0.5 + Math.random() * 0.5);
    return Math.min(Math.round(jittered), this.maxRetryDelayMs);
  }

  async #execute(op: OperationSpec, input: Record<string, unknown> | undefined, options: RequestOptions): Promise<{ data: unknown; meta: ResponseMeta }> {
    const req = buildRequest(op, input, this.baseUrl, this.org);
    const headers: Record<string, string> = {
      ...this.#headers,
      ...req.headers,
      ...(options.headers ?? {}),
      'x-coderabbitai-api-key': this.#apiKey,
    };
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const slow = SLOW_OPERATIONS[op.id];
    const timeoutMs = options.timeoutMs ?? (slow !== undefined ? Math.max(slow, this.timeoutMs) : this.timeoutMs);
    const unsafe = op.method === 'POST' || op.method === 'PATCH';
    const body = input?.body;
    const keyed = op.idempotencyKey !== null && isObject(body) && body[op.idempotencyKey] !== undefined && body[op.idempotencyKey] !== null;
    const retryFailures = !unsafe || options.retryUnsafe === true || keyed;
    const signal = options.signal;

    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw signal.reason;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });

      let outcome: { kind: 'ok'; data: unknown; response: Response } | { kind: 'error'; response: Response; text: string };
      try {
        const response = await this.#fetch(req.url, { method: req.method, headers, body: req.body, signal: controller.signal });
        if (response.ok) outcome = { kind: 'ok', data: await readSuccess(response), response };
        else outcome = { kind: 'error', response, text: await response.text() };
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (err instanceof CodeRabbitError && !timedOut) throw err;
        const failure = timedOut ? new CodeRabbitTimeoutError(timeoutMs, req.url) : new CodeRabbitConnectionError(req.url, err);
        if (retryFailures && attempt <= maxRetries) {
          await this.#sleep(this.#backoff(attempt), signal);
          continue;
        }
        throw failure;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }

      const { response } = outcome;
      const meta: ResponseMeta = { status: response.status, headers: response.headers, url: response.url || req.url, attempts: attempt };
      if (outcome.kind === 'ok') return { data: outcome.data, meta };

      const error = createApiError({
        status: response.status,
        statusText: response.statusText,
        body: parseMaybeJson(outcome.text),
        rawBody: outcome.text,
        headers: response.headers,
        method: req.method,
        url: req.url,
        operationId: op.id,
        attempts: attempt,
      });
      const status = response.status;
      const retryable = status === 429 || (status >= 500 && status !== 501 && retryFailures);
      if (retryable && attempt <= maxRetries) {
        const wait = error.retryAfterMs ?? this.#backoff(attempt);
        if (wait <= this.maxRetryDelayMs) {
          await this.#sleep(wait, signal);
          continue;
        }
      }
      throw error;
    }
  }
}

// Declaration merging adds the generated namespaces (identity, reviews, code, ...) to the class type.
export interface CodeRabbit extends Resources {}
