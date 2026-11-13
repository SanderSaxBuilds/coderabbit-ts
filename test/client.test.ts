import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { json, mockClient } from './helpers.ts';
import { BASE_URLS, CodeRabbit, CodeRabbitError, getOperation } from '../src/index.ts';

describe('configuration', () => {
  it('uses the US base URL by default', async () => {
    const { client, calls } = mockClient();
    await client.identity.getMe();
    assert.equal(calls[0]!.url.href, 'https://api.coderabbit.ai/v1/me');
  });

  it('uses the EU base URL for region eu', async () => {
    const { client, calls } = mockClient(undefined, { region: 'eu' });
    await client.identity.getMe();
    assert.equal(calls[0]!.url.href, 'https://api.eu.coderabbit.ai/v1/me');
    assert.equal(BASE_URLS.eu, 'https://api.eu.coderabbit.ai');
  });

  it('accepts a custom base URL and trims trailing slashes', async () => {
    const { client, calls } = mockClient(undefined, { baseUrl: 'http://localhost:8080/proxy/' });
    await client.identity.getMe();
    assert.equal(calls[0]!.url.href, 'http://localhost:8080/proxy/v1/me');
  });

  it('keeps the /api/v1 prefix of the report.generate route', async () => {
    const { client, calls } = mockClient(() => json([]));
    await client.reports.reportGenerate({ body: { from: '2026-01-01', to: '2026-01-31' } as never });
    assert.equal(calls[0]!.url.pathname, '/api/v1/report.generate');
    assert.equal(calls[0]!.method, 'POST');
  });

  it('requires an API key', () => {
    const saved = process.env.CODERABBIT_API_KEY;
    delete process.env.CODERABBIT_API_KEY;
    try {
      assert.throws(() => new CodeRabbit({ fetch: async () => json({}) }), /apiKey is required/);
    } finally {
      if (saved !== undefined) process.env.CODERABBIT_API_KEY = saved;
    }
  });

  it('reads CODERABBIT_API_KEY from the environment', async () => {
    const saved = process.env.CODERABBIT_API_KEY;
    process.env.CODERABBIT_API_KEY = 'from-env';
    try {
      let header: string | undefined;
      const client = new CodeRabbit({
        fetch: async (_url, init) => {
          header = (init.headers as Record<string, string>)['x-coderabbitai-api-key'];
          return json({});
        },
      });
      await client.identity.getMe();
      assert.equal(header, 'from-env');
    } finally {
      if (saved === undefined) delete process.env.CODERABBIT_API_KEY;
      else process.env.CODERABBIT_API_KEY = saved;
    }
  });

  it('rejects an unknown region', () => {
    assert.throws(() => new CodeRabbit({ apiKey: 'k', region: 'apac' as never, fetch: async () => json({}) }), /unknown region/);
  });

  it('sends client, per-request and accept headers, and the key last so it cannot be overridden', async () => {
    const { client, calls } = mockClient(undefined, { headers: { 'x-trace': 'a', 'x-coderabbitai-api-key': 'spoof' } });
    await client.identity.getMe(undefined, { headers: { 'x-request': 'b' } });
    const h = calls[0]!.headers;
    assert.equal(h['x-trace'], 'a');
    assert.equal(h['x-request'], 'b');
    assert.equal(h['x-coderabbitai-api-key'], 'test-key');
    assert.equal(h.accept, 'application/json');
  });

  it('asks for every content type the operation documents', async () => {
    const { client, calls } = mockClient(() => new Response('a,b\n', { headers: { 'content-type': 'text/csv' } }));
    const out = await client.bugScan.bugScanFindingsList({ repo_id: '1', format: 'csv' });
    assert.equal(calls[0]!.headers.accept, 'application/json, text/csv, application/sarif+json');
    assert.equal(out, 'a,b\n');
  });
});

describe('request building', () => {
  it('encodes path parameters', async () => {
    const { client, calls } = mockClient();
    await client.repositories.getRepository({ repository_id: 'a/b c' });
    assert.equal(calls[0]!.url.pathname, '/v1/repositories/a%2Fb%20c');
  });

  it('repeats exploded array query parameters', async () => {
    const { client, calls } = mockClient();
    await client.security.listSecurityFindings({ repository_ids: ['r1', 'r2'], severity: ['critical', 'high'] });
    assert.deepEqual(calls[0]!.url.searchParams.getAll('repository_ids'), ['r1', 'r2']);
    assert.deepEqual(calls[0]!.url.searchParams.getAll('severity'), ['critical', 'high']);
  });

  it('comma-joins arrays the spec marks explode: false', async () => {
    const { client, calls } = mockClient();
    await client.auditLogs.auditLogsList({ actions: ['a', 'b'] as never, resource_types: ['x'] as never });
    assert.equal(calls[0]!.url.search, '?actions=a%2Cb&resource_types=x');
  });

  it('serializes deepObject query parameters', async () => {
    const { client, calls } = mockClient();
    await client.code.getCodeAutofix({ target: { type: 'pull_request', repoId: 'r1', prNumber: 7 } });
    assert.equal(calls[0]!.url.searchParams.get('target[type]'), 'pull_request');
    assert.equal(calls[0]!.url.searchParams.get('target[repoId]'), 'r1');
    assert.equal(calls[0]!.url.searchParams.get('target[prNumber]'), '7');
  });

  it('serializes booleans and numbers', async () => {
    const { client, calls } = mockClient();
    await client.code.listCodeTasks({ include_archived: true, page_size: 5 });
    assert.equal(calls[0]!.url.searchParams.get('include_archived'), 'true');
    assert.equal(calls[0]!.url.searchParams.get('page_size'), '5');
  });

  it('skips undefined values', async () => {
    const { client, calls } = mockClient();
    await client.code.listCodeTasks({ page_size: undefined, repository_id: 'r' });
    assert.equal(calls[0]!.url.search, '?repository_id=r');
  });

  it('rejects parameters the operation does not declare', async () => {
    const { client, calls } = mockClient();
    await assert.rejects(client.identity.getMe({ nope: 1 } as never), /unknown parameter nope/);
    assert.equal(calls.length, 0);
  });

  it('rejects a body on an operation without one', async () => {
    const { client } = mockClient();
    await assert.rejects(client.identity.getMe({ body: {} } as never), /takes no request body/);
  });

  it('rejects org_id together with org_name, as the docs say the API does', async () => {
    const { client, calls } = mockClient();
    await assert.rejects(client.identity.getMe({ org_id: '1', org_name: 'acme' }), /not both/);
    await assert.rejects(client.reviews.requestPullRequestReview({ repository_id: '1', pull_request_number: 2, body: { org_id: '1', org_name: 'a' } }), /not both/);
    assert.equal(calls.length, 0);
  });

  it('lets an explicit selector win over the client default', async () => {
    const { client, calls } = mockClient(undefined, { org: { org_name: 'default-org' } });
    await client.identity.getMe({ org_id: '123' });
    assert.equal(calls[0]!.url.search, '?org_id=123');
    await client.reviews.requestPullRequestReview({ repository_id: '1', pull_request_number: 2, body: { org_id: '9' } });
    assert.deepEqual(JSON.parse(calls[1]!.body!), { org_id: '9' });
  });

  it('adds the default selector to an optional body that was not given', async () => {
    const { client, calls } = mockClient(() => json({}, 202), { org: { org_id: '42' } });
    await client.reviews.requestPullRequestReview({ repository_id: '1', pull_request_number: 2 });
    assert.deepEqual(JSON.parse(calls[0]!.body!), { org_id: '42' });
    assert.equal(calls[0]!.headers['content-type'], 'application/json');
  });

  it('call() and the namespaced method send the same request', async () => {
    const { client, calls } = mockClient();
    await client.call('get_repository_pull_request', { repository_id: '5', pull_request_number: 9, include: ['checks', 'threads'] });
    await client.pullRequests.getRepositoryPullRequest({ repository_id: '5', pull_request_number: 9, include: ['checks', 'threads'] });
    assert.equal(calls[0]!.url.href, calls[1]!.url.href);
    assert.deepEqual(calls[0]!.url.searchParams.getAll('include'), ['checks', 'threads']);
  });

  it('exposes the operation table', () => {
    const op = getOperation('request_pull_request_review');
    assert.equal(op.method, 'POST');
    assert.equal(op.path, '/v1/repositories/{repository_id}/pull-requests/{pull_request_number}/review');
    assert.equal(op.org, 'body');
    assert.throws(() => getOperation('nope'), /Unknown operation/);
  });
});

describe('response parsing', () => {
  it('returns undefined for 204', async () => {
    const { client } = mockClient(() => new Response(null, { status: 204 }));
    assert.equal(await client.learnings.learningsDelete({ learning_id: 'l1' }), undefined);
  });

  it('returns undefined for an empty JSON body', async () => {
    const { client } = mockClient(() => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }));
    assert.equal(await client.identity.getMe(), undefined);
  });

  it('parses JSON when the content type is missing', async () => {
    // A byte body, so the Response constructor does not add a text/plain type.
    const { client } = mockClient(() => new Response(new TextEncoder().encode('{"a":1}'), { status: 200 }));
    assert.deepEqual(await client.identity.getMe(), { a: 1 });
  });

  it('throws CodeRabbitError on malformed JSON', async () => {
    const { client } = mockClient(() => new Response('{oops', { status: 200, headers: { 'content-type': 'application/json' } }));
    await assert.rejects(client.identity.getMe(), (e: unknown) => e instanceof CodeRabbitError && /not valid JSON/.test(e.message));
  });

  it('returns binary evidence as ArrayBuffer and passes the Range header', async () => {
    const { client, calls } = mockClient(() => new Response(new Uint8Array([1, 2]), { status: 206, headers: { 'content-type': 'video/mp4' } }));
    const out = await client.verify.downloadVerifyEvidence({ repository_id: 'r', execution_id: 'e', artifact_id: 'a', Range: 'bytes=0-1' });
    assert.ok(out instanceof ArrayBuffer);
    assert.equal(calls[0]!.headers.range, 'bytes=0-1');
  });

  it('callWithResponse returns status, headers and attempts', async () => {
    const { client } = mockClient(() => json({ ok: true }, 200, { 'x-ratelimit-remaining': '9' }));
    const { data, response } = await client.callWithResponse('get_me');
    assert.deepEqual(data, { ok: true });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-ratelimit-remaining'), '9');
    assert.equal(response.attempts, 1);
  });
});
