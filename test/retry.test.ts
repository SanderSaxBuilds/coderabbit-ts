import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { json, mockClient } from './helpers.ts';
import {
  CodeRabbit,
  CodeRabbitApiError,
  CodeRabbitConnectionError,
  CodeRabbitRateLimitError,
  CodeRabbitServerError,
  CodeRabbitTimeoutError,
  parseRetryAfter,
} from '../src/index.ts';

const rateLimited = (headers: Record<string, string> = {}, body: unknown = { error: { code: 'rate_limit_exceeded', message: 'slow down' } }) =>
  json(body, 429, headers);

describe('retries', () => {
  it('retries a 429 after the Retry-After seconds', async () => {
    const { client, calls, sleeps } = mockClient((_r, i) => (i === 0 ? rateLimited({ 'retry-after': '3' }) : json({ ok: 1 })));
    assert.deepEqual(await client.identity.getMe(), { ok: 1 });
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [3000]);
  });

  it('understands an HTTP-date Retry-After', () => {
    const now = Date.parse('2026-11-13T00:00:00Z');
    assert.equal(parseRetryAfter('Fri, 13 Nov 2026 00:00:05 GMT', now), 5000);
    assert.equal(parseRetryAfter('garbage', now), undefined);
    assert.equal(parseRetryAfter('1.5', now), 1500);
  });

  it('falls back to error.retry_after in the body', async () => {
    const body = { error: { code: 'rate_limit_exceeded', message: 'x', retry_after: 7 } };
    const { client, sleeps } = mockClient((_r, i) => (i === 0 ? rateLimited({}, body) : json({})));
    await client.code.listCodeTasks();
    assert.deepEqual(sleeps, [7000]);
  });

  it('prefers the header over the body value', async () => {
    const body = { error: { code: 'rate_limit_exceeded', message: 'x', retry_after: 7 } };
    const { client, sleeps } = mockClient((_r, i) => (i === 0 ? rateLimited({ 'retry-after': '2' }, body) : json({})));
    await client.code.listCodeTasks();
    assert.deepEqual(sleeps, [2000]);
  });

  it('retries 429 even for POST, since the request was not processed', async () => {
    const { client, calls } = mockClient((_r, i) => (i === 0 ? rateLimited({ 'retry-after': '1' }) : json({}, 202)));
    await client.reviews.requestPullRequestReview({ repository_id: '1', pull_request_number: 2 });
    assert.equal(calls.length, 2);
  });

  it('retries 5xx on GET with exponential backoff', async () => {
    const { client, calls, sleeps } = mockClient((_r, i) => (i < 2 ? json({}, 503) : json({ ok: 1 })), { baseRetryDelayMs: 100 });
    await client.identity.getMe();
    assert.equal(calls.length, 3);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[0]! >= 50 && sleeps[0]! <= 100, `first wait ${sleeps[0]}`);
    assert.ok(sleeps[1]! >= 100 && sleeps[1]! <= 200, `second wait ${sleeps[1]}`);
  });

  it('does not retry POST on 5xx by default', async () => {
    const { client, calls } = mockClient(() => json({ error: { code: 'internal_error', message: 'boom' } }, 500));
    await assert.rejects(client.code.createCodeTask({ body: { prompt: 'x' } as never }), CodeRabbitServerError);
    assert.equal(calls.length, 1);
  });

  it('retries POST on 5xx when retryUnsafe is set', async () => {
    const { client, calls } = mockClient((_r, i) => (i === 0 ? json({}, 502) : json({})));
    await client.code.createCodeTask({ body: { prompt: 'x' } as never }, { retryUnsafe: true });
    assert.equal(calls.length, 2);
  });

  it('retries POST on 5xx when the body carries a client_operation_id', async () => {
    const { client, calls } = mockClient((_r, i) => (i === 0 ? json({}, 500) : json({}, 202)));
    await client.code.createCodeTaskTurn({ task_id: 't', body: { message: 'go', client_operation_id: 'op-1' } as never });
    assert.equal(calls.length, 2);
  });

  it('does not retry 4xx other than 429', async () => {
    const { client, calls } = mockClient(() => json({ error: { code: 'forbidden', message: 'no' } }, 403));
    await assert.rejects(client.identity.getMe(), CodeRabbitApiError);
    assert.equal(calls.length, 1);
  });

  it('does not retry 501', async () => {
    const { client, calls } = mockClient(() => json({}, 501));
    await assert.rejects(client.identity.getMe());
    assert.equal(calls.length, 1);
  });

  it('stops after maxRetries and reports the attempts', async () => {
    const { client, calls } = mockClient(() => rateLimited({ 'retry-after': '1' }), { maxRetries: 3 });
    const err = await client.identity.getMe().catch((e: unknown) => e);
    assert.ok(err instanceof CodeRabbitRateLimitError);
    assert.equal(err.attempts, 4);
    assert.equal(calls.length, 4);
  });

  it('per-request maxRetries overrides the client setting', async () => {
    const { client, calls } = mockClient(() => json({}, 503), { maxRetries: 5 });
    await assert.rejects(client.identity.getMe(undefined, { maxRetries: 0 }));
    assert.equal(calls.length, 1);
  });

  it('gives up instead of waiting longer than maxRetryDelayMs', async () => {
    const { client, calls, sleeps } = mockClient(() => rateLimited({ 'retry-after': '3600' }), { maxRetryDelayMs: 60_000 });
    const err = await client.identity.getMe().catch((e: unknown) => e);
    assert.ok(err instanceof CodeRabbitRateLimitError);
    assert.equal(err.retryAfterMs, 3_600_000);
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  });

  it('reads the X-RateLimit headers the spec documents', async () => {
    const { client } = mockClient(() => rateLimited({ 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1763000000' }), { maxRetries: 0 });
    const err = await client.users.listUsers().catch((e: unknown) => e);
    assert.ok(err instanceof CodeRabbitRateLimitError);
    assert.deepEqual(err.rateLimit, { limit: 10, remaining: 0, reset: 1763000000 });
  });

  it('retries network errors on GET and wraps the final one', async () => {
    let n = 0;
    const client = new CodeRabbit({
      apiKey: 'k',
      sleep: async () => {},
      fetch: async () => {
        n += 1;
        throw new TypeError('fetch failed');
      },
    });
    const err = await client.identity.getMe().catch((e: unknown) => e);
    assert.ok(err instanceof CodeRabbitConnectionError);
    assert.ok((err as Error).cause instanceof TypeError);
    assert.equal(n, 3);
  });

  it('does not retry network errors on POST', async () => {
    let n = 0;
    const client = new CodeRabbit({
      apiKey: 'k',
      sleep: async () => {},
      fetch: async () => {
        n += 1;
        throw new TypeError('socket hang up');
      },
    });
    await assert.rejects(client.code.deliverCodeTask({ task_id: 't' }), CodeRabbitConnectionError);
    assert.equal(n, 1);
  });
});

describe('timeouts and cancellation', () => {
  const hanging = (calls: { n: number }) => async (_url: string, init: RequestInit) => {
    calls.n += 1;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
    });
  };

  it('times out a hanging request', async () => {
    const calls = { n: 0 };
    const client = new CodeRabbit({ apiKey: 'k', fetch: hanging(calls), timeoutMs: 20, maxRetries: 0 });
    const err = await client.identity.getMe().catch((e: unknown) => e);
    assert.ok(err instanceof CodeRabbitTimeoutError);
    assert.equal(err.timeoutMs, 20);
    assert.equal(calls.n, 1);
  });

  it('retries a timed-out GET', async () => {
    const calls = { n: 0 };
    const client = new CodeRabbit({ apiKey: 'k', fetch: hanging(calls), timeoutMs: 10, maxRetries: 2, sleep: async () => {} });
    await assert.rejects(client.identity.getMe(), CodeRabbitTimeoutError);
    assert.equal(calls.n, 3);
  });

  it('per-request timeoutMs overrides the client value', async () => {
    const calls = { n: 0 };
    const client = new CodeRabbit({ apiKey: 'k', fetch: hanging(calls), timeoutMs: 60_000, maxRetries: 0 });
    const err = await client.identity.getMe(undefined, { timeoutMs: 15 }).catch((e: unknown) => e);
    assert.ok(err instanceof CodeRabbitTimeoutError);
    assert.equal(err.timeoutMs, 15);
  });

  it('honours a caller AbortSignal without retrying', async () => {
    const calls = { n: 0 };
    const client = new CodeRabbit({ apiKey: 'k', fetch: hanging(calls), maxRetries: 5 });
    const controller = new AbortController();
    const pending = client.identity.getMe(undefined, { signal: controller.signal }).catch((e: unknown) => e);
    setTimeout(() => controller.abort(new Error('user cancelled')), 5);
    const err = await pending;
    assert.equal((err as Error).message, 'user cancelled');
    assert.equal(calls.n, 1);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const { client, calls } = mockClient();
    const controller = new AbortController();
    controller.abort(new Error('early'));
    await assert.rejects(client.identity.getMe(undefined, { signal: controller.signal }), /early/);
    assert.equal(calls.length, 0);
  });

  it('aborting during a retry wait stops the wait', async () => {
    const controller = new AbortController();
    const client = new CodeRabbit({
      apiKey: 'k',
      fetch: async () => json({}, 503, { 'retry-after': '30' }),
      maxRetries: 3,
    });
    const pending = client.identity.getMe(undefined, { signal: controller.signal }).catch((e: unknown) => e);
    setTimeout(() => controller.abort(new Error('cancel wait')), 10);
    const started = Date.now();
    const err = await pending;
    assert.equal((err as Error).message, 'cancel wait');
    assert.ok(Date.now() - started < 5000);
  });
});
