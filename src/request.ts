import { OPERATIONS } from './generated/operations.ts';
import type { OperationId } from './generated/operations.ts';
import type { OrgSelector } from './types.ts';

/** Runtime description of one operation, as generated from the spec. */
export interface OperationSpec {
  readonly id: string;
  readonly namespace: string;
  readonly method: string;
  readonly path: string;
  readonly pathParams: readonly string[];
  readonly query: readonly { readonly name: string; readonly required: boolean; readonly style: string; readonly array: boolean; readonly explode: boolean }[];
  readonly headers: readonly { readonly name: string; readonly required: boolean }[];
  readonly body: 'required' | 'optional' | null;
  readonly org: 'query' | 'body' | null;
  readonly idempotencyKey: string | null;
  readonly success: readonly { readonly status: number; readonly types: readonly string[] }[];
  readonly pagination:
    | { readonly kind: 'cursor'; readonly param: string; readonly next: string; readonly items: string }
    | { readonly kind: 'page'; readonly param: string; readonly start: number; readonly items: string }
    | null;
}

const TABLE: Readonly<Record<string, OperationSpec>> = OPERATIONS;

export function getOperation(id: OperationId | string): OperationSpec {
  const op = TABLE[id];
  if (!op) throw new TypeError(`Unknown operation ${id}`);
  return op;
}

export function listOperations(): OperationSpec[] {
  return Object.values(TABLE);
}

export interface BuiltRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function scalar(value: unknown, name: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  throw new TypeError(`Parameter ${name} must be a string, number, boolean or Date`);
}

/**
 * Turns an operation input object into method, URL, headers and body,
 * following the spec's parameter locations and array styles.
 * Throws TypeError for missing required parameters and for keys the operation does not declare.
 */
export function buildRequest(op: OperationSpec, input: Record<string, unknown> | undefined, baseUrl: string, org: OrgSelector | undefined): BuiltRequest {
  const values: Record<string, unknown> = { ...(input ?? {}) };
  let body: unknown = values.body;
  delete values.body;

  if (values.org_id !== undefined && values.org_name !== undefined) {
    throw new TypeError(`${op.id}: supply org_id or org_name, not both`);
  }
  if (body !== undefined && typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    if (b.org_id !== undefined && b.org_name !== undefined) throw new TypeError(`${op.id}: supply org_id or org_name, not both`);
  }

  const known = new Set<string>([...op.pathParams, ...op.query.map((q) => q.name), ...op.headers.map((h) => h.name)]);
  for (const key of Object.keys(values)) {
    if (values[key] === undefined) continue;
    if (!known.has(key)) throw new TypeError(`${op.id}: unknown parameter ${key}`);
  }
  if (body !== undefined && op.body === null) throw new TypeError(`${op.id}: this operation takes no request body`);

  if (org) {
    const hasSelector = (o: Record<string, unknown>) => o.org_id !== undefined || o.org_name !== undefined;
    if (op.org === 'query' && !hasSelector(values)) {
      Object.assign(values, org);
    } else if (op.org === 'body') {
      const current = (body ?? {}) as Record<string, unknown>;
      if (typeof current === 'object' && current !== null && !Array.isArray(current) && !hasSelector(current)) {
        body = { ...current, ...org };
      }
    }
  }

  let path: string = op.path;
  for (const name of op.pathParams) {
    const value = values[name];
    if (value === undefined || value === null || value === '') throw new TypeError(`${op.id}: missing path parameter ${name}`);
    path = path.replace(`{${name}}`, encodeURIComponent(scalar(value, name)));
  }

  const search = new URLSearchParams();
  for (const q of op.query) {
    const value = values[q.name];
    if (value === undefined || value === null) {
      if (q.required) throw new TypeError(`${op.id}: missing query parameter ${q.name}`);
      continue;
    }
    if (q.style === 'deepObject' && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        const key2 = `${q.name}[${key}]`;
        if (inner !== undefined && inner !== null) search.append(key2, scalar(inner, key2));
      }
    } else if (Array.isArray(value)) {
      const items = value.map((v) => scalar(v, q.name));
      if (q.explode) for (const item of items) search.append(q.name, item);
      else search.append(q.name, items.join(','));
    } else {
      search.append(q.name, scalar(value, q.name));
    }
  }

  const headers: Record<string, string> = {};
  for (const h of op.headers) {
    const value = values[h.name];
    if (value === undefined || value === null) {
      if (h.required) throw new TypeError(`${op.id}: missing header ${h.name}`);
      continue;
    }
    headers[h.name] = scalar(value, h.name);
  }

  if (op.body === 'required' && body === undefined) throw new TypeError(`${op.id}: missing request body`);

  const accept = new Set<string>();
  for (const s of op.success) for (const t of s.types) accept.add(t);
  headers.accept = accept.size ? [...accept].join(', ') : 'application/json';

  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }

  const qs = search.toString();
  const url = `${baseUrl.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`;
  return { method: op.method, url, headers, body: payload };
}
