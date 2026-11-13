import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { CodeRabbit } from '../src/index.ts';
import type { ClientOptions } from '../src/index.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = Record<string, any>;

let cached: Schema | undefined;

/** The pinned spec, read straight from spec/openapi.json.gz, independent of the generated code. */
export function loadSpec(): Schema {
  if (!cached) {
    const text = gunzipSync(readFileSync(new URL('../spec/openapi.json.gz', import.meta.url))).toString('utf8').replace(/^﻿/, '');
    cached = JSON.parse(text) as Schema;
  }
  return cached;
}

export function resolve(node: any): any {
  const spec = loadSpec();
  let cur = node;
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
    cur = cur.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce((acc: any, key: string) => acc?.[key], spec);
  }
  return cur;
}

export interface SpecParam {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  schema: Schema;
  style?: string;
  explode?: boolean;
  example?: unknown;
}

export interface SpecOperation {
  id: string;
  method: string;
  path: string;
  tag: string | undefined;
  params: SpecParam[];
  requestBody: Schema | undefined;
  responses: Record<string, Schema>;
  raw: Schema;
}

export function specOperations(): SpecOperation[] {
  const spec = loadSpec();
  const out: SpecOperation[] = [];
  for (const [p, item] of Object.entries<any>(spec.paths)) {
    for (const method of ['get', 'put', 'post', 'delete', 'patch', 'head', 'options']) {
      const op = item[method];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((x: any) => {
        const r = resolve(x);
        return { ...r, required: r.required === true } as SpecParam;
      });
      out.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path: p,
        tag: op.tags?.[0],
        params,
        requestBody: op.requestBody ? resolve(op.requestBody) : undefined,
        responses: Object.fromEntries(Object.entries<any>(op.responses ?? {}).map(([k, v]) => [k, resolve(v)])),
        raw: op,
      });
    }
  }
  return out;
}

export function isArraySchema(schema: Schema | undefined): boolean {
  const s = resolve(schema) ?? {};
  if (s.type === 'array') return true;
  return [...(s.anyOf ?? []), ...(s.oneOf ?? [])].some((x: any) => resolve(x)?.type === 'array');
}

function sampleString(s: Schema, hint: string): string {
  if (s.format === 'date-time') return '2026-01-02T03:04:05.000Z';
  if (s.format === 'date') return '2026-01-02';
  if (s.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
  if (s.format === 'uri' || s.format === 'url') return 'https://example.com/x';
  if (s.format === 'email') return 'dev@example.com';
  const base = `${hint || 'value'}-1`;
  const min = typeof s.minLength === 'number' ? s.minLength : 0;
  return base.length >= min ? base : base.padEnd(min, 'x');
}

/**
 * Builds a JSON value that fits a schema, preferring the spec's own example,
 * default, const and enum values. `full` fills optional properties too.
 */
export function sample(schema: Schema | undefined, opts: { full?: boolean; hint?: string; depth?: number } = {}): Json {
  const depth = opts.depth ?? 0;
  const s = resolve(schema);
  if (!s || typeof s !== 'object') return null;
  if (s.example !== undefined) return s.example as Json;
  if (s.const !== undefined) return s.const as Json;
  if (s.default !== undefined) return s.default as Json;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0] as Json;
  if (depth > 8) return s.nullable ? null : s.type === 'array' ? [] : s.type === 'object' ? {} : null;
  if (Array.isArray(s.allOf)) {
    const merged: Record<string, Json> = {};
    for (const part of s.allOf) {
      const v = sample(part, { ...opts, depth: depth + 1 });
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(merged, v);
    }
    return merged;
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(s[key]) && s[key].length) {
      const choice = s[key].find((x: any) => {
        const r = resolve(x);
        return !(Array.isArray(r?.enum) && r.enum.length === 1 && r.enum[0] === null);
      }) ?? s[key][0];
      return sample(choice, { ...opts, depth: depth + 1 });
    }
  }
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type ?? (s.properties ? 'object' : s.items ? 'array' : undefined);
  switch (type) {
    case 'string':
      return sampleString(s, opts.hint ?? '');
    case 'integer':
    case 'number': {
      let n = typeof s.minimum === 'number' ? s.minimum : 1;
      if (s.exclusiveMinimum === true || (typeof s.exclusiveMinimum === 'number' && n <= s.exclusiveMinimum)) n += 1;
      if (typeof s.maximum === 'number' && n > s.maximum) n = s.maximum;
      return n;
    }
    case 'boolean':
      return true;
    case 'array': {
      const min = typeof s.minItems === 'number' ? Math.max(1, s.minItems) : 1;
      return Array.from({ length: min }, () => sample(s.items, { ...opts, depth: depth + 1 }));
    }
    case 'object': {
      const obj: Record<string, Json> = {};
      const required: string[] = s.required ?? [];
      for (const [key, value] of Object.entries<any>(s.properties ?? {})) {
        if (!opts.full && !required.includes(key)) continue;
        obj[key] = sample(value, { ...opts, hint: key, depth: depth + 1 });
      }
      return obj;
    }
    default:
      return s.nullable ? null : {};
  }
}

export interface Captured {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Responder = (req: Captured, index: number) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A client whose fetch records every request and answers with `respond`. */
export function mockClient(respond: Responder = () => json({}), options: ClientOptions = {}): { client: CodeRabbit; calls: Captured[]; sleeps: number[] } {
  const calls: Captured[] = [];
  const sleeps: number[] = [];
  const client = new CodeRabbit({
    apiKey: 'test-key',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
    fetch: async (input, init) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      const captured: Captured = { url: new URL(input), method: String(init.method), headers, body: typeof init.body === 'string' ? init.body : undefined };
      calls.push(captured);
      if (init.signal?.aborted) throw init.signal.reason;
      return respond(captured, calls.length - 1);
    },
  });
  return { client, calls, sleeps };
}

export function camel(id: string): string {
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.toLowerCase() : p[0]!.toUpperCase() + p.slice(1).toLowerCase()))
    .join('');
}
