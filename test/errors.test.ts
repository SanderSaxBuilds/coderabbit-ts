import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from './helpers.ts';
import { CodeRabbitApiError, CodeRabbitAuthenticationError, CodeRabbitGoneError, CodeRabbitPermissionError, readErrorBody } from '../src/index.ts';

describe('error bodies', () => {
  it('reads the shared Platform API shape', () => {
    assert.deepEqual(readErrorBody({ error: { code: 'forbidden', message: 'Agentic key required', retry_after: 4 } }), {
      code: 'forbidden',
      message: 'Agentic key required',
      retryAfterSeconds: 4,
    });
  });

  it('reads the errors[] shape used by report and metrics routes', () => {
    assert.deepEqual(
      readErrorBody({
        errors: [
          { code: 'INVALID_PARAMETER', message: 'start_date: start_date is required' },
          { code: 'INVALID_PARAMETER', message: 'end_date: end_date is required' },
        ],
      }),
      { code: 'INVALID_PARAMETER', message: 'start_date: start_date is required; end_date: end_date is required' },
    );
  });

  it('reads the flat { code, message } shape from the report examples', () => {
    assert.deepEqual(readErrorBody({ message: 'Invalid or missing API key', code: 'UNAUTHORIZED' }), {
      code: 'UNAUTHORIZED',
      message: 'Invalid or missing API key',
    });
  });

  it('returns nothing for bodies it does not recognise', () => {
    assert.deepEqual(readErrorBody('nope'), {});
    assert.deepEqual(readErrorBody(null), {});
    assert.deepEqual(readErrorBody([1]), {});
  });
});

describe('typed errors', () => {
  it('builds a readable message with method, path, status and code', async () => {
    const { client } = mockClient(
      () => new Response(JSON.stringify({ error: { code: 'unauthenticated', message: 'Key revoked' } }), { status: 401, headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' } }),
      { maxRetries: 0 },
    );
    const err = await client.identity.getMe().catch((e: unknown) => e);
    assert.ok(err instanceof CodeRabbitAuthenticationError);
    assert.equal(err.message, 'GET /v1/me failed with 401 unauthenticated: Key revoked');
    assert.equal(err.serverMessage, 'Key revoked');
    assert.equal(err.requestId, 'req-1');
    assert.equal(err.method, 'GET');
    assert.equal(err.url, 'https://api.coderabbit.ai/v1/me');
  });

  it('keeps a non-JSON error body as text', async () => {
    const { client } = mockClient(() => new Response('upstream unavailable', { status: 403 }), { maxRetries: 0 });
    const err = await client.identity.getMe().catch((e: unknown) => e);
    assert.ok(err instanceof CodeRabbitPermissionError);
    assert.equal(err.body, 'upstream unavailable');
    assert.equal(err.rawBody, 'upstream unavailable');
    assert.match(err.message, /403: upstream unavailable$/);
  });

  it('uses the status text when the body is empty', async () => {
    const { client } = mockClient(() => new Response(null, { status: 410, statusText: 'Gone' }), { maxRetries: 0 });
    const err = await client.users.addUsers({ body: {} as never }).catch((e: unknown) => e);
    assert.ok(err instanceof CodeRabbitGoneError);
    assert.equal(err.code, undefined);
    assert.match(err.message, /410: Gone$/);
  });

  it('falls back to CodeRabbitApiError for undocumented statuses', async () => {
    const { client } = mockClient(() => new Response('{}', { status: 418, headers: { 'content-type': 'application/json' } }), { maxRetries: 0 });
    const err = await client.identity.getMe().catch((e: unknown) => e);
    assert.ok(err instanceof CodeRabbitApiError);
    assert.equal(err.constructor, CodeRabbitApiError);
    assert.equal(err.status, 418);
  });
});
