// Response handling per operation, using fixtures built from the spec's own
// examples and schemas: every documented 2xx body comes back parsed, and every
// documented error status becomes the matching typed error with its code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient, resolve, sample, specOperations } from './helpers.ts';
import type { SpecOperation } from './helpers.ts';
import {
  CodeRabbitApiError,
  CodeRabbitAuthenticationError,
  CodeRabbitBadRequestError,
  CodeRabbitConflictError,
  CodeRabbitGoneError,
  CodeRabbitNotFoundError,
  CodeRabbitPaymentRequiredError,
  CodeRabbitPermissionError,
  CodeRabbitRateLimitError,
  CodeRabbitServerError,
  readErrorBody,
} from '../src/index.ts';

const ops = specOperations();
const AUTH = 'x-coderabbitai-api-key';

const EXPECTED_CLASS: Record<number, new (...args: never[]) => CodeRabbitApiError> = {
  400: CodeRabbitBadRequestError,
  401: CodeRabbitAuthenticationError,
  402: CodeRabbitPaymentRequiredError,
  403: CodeRabbitPermissionError,
  404: CodeRabbitNotFoundError,
  409: CodeRabbitConflictError,
  410: CodeRabbitGoneError,
  412: CodeRabbitConflictError,
  413: CodeRabbitBadRequestError,
  429: CodeRabbitRateLimitError,
  500: CodeRabbitServerError,
  503: CodeRabbitServerError,
};

function input(op: SpecOperation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of op.params) {
    if (p.in === 'header' && p.name.toLowerCase() === AUTH) continue;
    if (p.in === 'path' || p.required) out[p.name] = p.example ?? sample(p.schema, { hint: p.name });
  }
  if (op.requestBody?.required) out.body = sample(op.requestBody.content['application/json'].schema);
  return out;
}

function fixture(media: Record<string, any>): unknown {
  if (media.example !== undefined) return media.example;
  if (media.examples && typeof media.examples === 'object') {
    const first = Object.values<any>(media.examples)[0];
    const value = resolve(first)?.value;
    if (value !== undefined) return value;
  }
  return sample(media.schema, { full: true });
}

const call = (client: unknown, id: string, args: Record<string, unknown>) =>
  ((client as { call: (id: string, input: unknown) => Promise<unknown> }).call)(id, args);

describe('success responses', () => {
  for (const op of ops) {
    const codes = Object.keys(op.responses).filter((c) => /^2\d\d$/.test(c));
    it(`${op.id}: ${codes.join(', ')}`, async () => {
      for (const code of codes) {
        const status = Number(code);
        const content: Record<string, any> = op.responses[code]!.content ?? {};
        const types = Object.keys(content);
        if (types.length === 0) {
          const { client } = mockClient(() => new Response(null, { status }), { maxRetries: 0 });
          assert.equal(await call(client, op.id, input(op)), undefined);
          continue;
        }
        for (const type of types) {
          const media = content[type];
          if (type.includes('json')) {
            const body = fixture(media);
            const { client } = mockClient(() => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } }), { maxRetries: 0 });
            assert.deepEqual(await call(client, op.id, input(op)), body, `${code} ${type}`);
          } else if (type.startsWith('text/')) {
            const text = 'id,name\n1,example\n';
            const { client } = mockClient(() => new Response(text, { status, headers: { 'content-type': type } }), { maxRetries: 0 });
            assert.equal(await call(client, op.id, input(op)), text, `${code} ${type}`);
          } else {
            const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
            const contentType = type === '*/*' ? 'application/octet-stream' : type;
            const { client } = mockClient(() => new Response(bytes, { status, headers: { 'content-type': contentType } }), { maxRetries: 0 });
            const out = await call(client, op.id, input(op));
            assert.ok(out instanceof ArrayBuffer, `${code} ${type} returns ArrayBuffer`);
            assert.deepEqual(new Uint8Array(out), bytes);
          }
        }
      }
    });
  }
});

describe('error responses', () => {
  for (const op of ops) {
    const codes = Object.keys(op.responses).filter((c) => /^[45]\d\d$/.test(c));
    if (codes.length === 0) continue;
    it(`${op.id}: ${codes.join(', ')}`, async () => {
      for (const code of codes) {
        const status = Number(code);
        const media = op.responses[code]!.content?.['application/json'];
        const body = media ? fixture(media) : undefined;
        const raw = body === undefined ? '' : JSON.stringify(body);
        const { client, calls } = mockClient(
          () => new Response(raw || null, { status, headers: raw ? { 'content-type': 'application/json' } : {} }),
          { maxRetries: 0 },
        );
        const err = await call(client, op.id, input(op)).then(
          () => assert.fail(`${op.id} ${code} should throw`),
          (e: unknown) => e,
        );
        assert.equal(calls.length, 1);
        assert.ok(err instanceof CodeRabbitApiError, `${code} is a CodeRabbitApiError`);
        const expected = EXPECTED_CLASS[status] ?? CodeRabbitApiError;
        assert.ok(err instanceof expected, `${code} maps to ${expected.name}, got ${err.name}`);
        assert.equal(err.status, status);
        assert.equal(err.operationId, op.id);
        assert.deepEqual(err.body, body);
        const parsed = readErrorBody(body);
        assert.equal(err.code, parsed.code, `${code} code`);
        if (parsed.message) assert.ok(err.message.includes(parsed.message.split('; ')[0]!), `${code} message is surfaced`);
      }
    });
  }
});
