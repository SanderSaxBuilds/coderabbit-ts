import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { json, mockClient } from './helpers.ts';
import { nextPageNumber } from '../src/index.ts';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe('cursor pagination', () => {
  it('follows next_cursor until it is null (list-users)', async () => {
    const pages = [
      { users: [{ user_id: 'u1' }, { user_id: 'u2' }], next_cursor: 'c2' },
      { users: [{ user_id: 'u3' }], next_cursor: null },
    ];
    const { client, calls } = mockClient((_r, i) => json(pages[i]));
    const users = await collect(client.items('list-users', { limit: 2 }));
    assert.deepEqual(users.map((u) => (u as unknown as { user_id: string }).user_id), ['u1', 'u2', 'u3']);
    assert.equal(calls[0]!.url.searchParams.get('cursor'), null);
    assert.equal(calls[1]!.url.searchParams.get('cursor'), 'c2');
    assert.equal(calls[1]!.url.searchParams.get('limit'), '2');
  });

  it('follows next_page_token through empty pages (list_repositories)', async () => {
    const pages = [
      { data: [], next_page_token: 't2' },
      { data: [{ id: 'r1' }], next_page_token: null },
    ];
    const { client, calls } = mockClient((_r, i) => json(pages[i]));
    const repos = await collect(client.items('list_repositories', { page_size: 50 }));
    assert.equal(repos.length, 1);
    assert.equal(calls[1]!.url.searchParams.get('page_token'), 't2');
  });

  it('reads the camelCase nextCursor used by triage rules', async () => {
    const pages = [
      { items: [{ id: 'a' }], nextCursor: 'n1' },
      { items: [{ id: 'b' }], nextCursor: null },
    ];
    const { client, calls } = mockClient((_r, i) => json(pages[i]));
    const rules = await collect(client.items('list_triage_rules'));
    assert.equal(rules.length, 2);
    assert.equal(calls[1]!.url.searchParams.get('cursor'), 'n1');
  });

  it('walks coding turns backwards with before_turn_start_seq', async () => {
    const pages = [
      { task_id: 't', data: [{ turn_start_seq: 9 }], next_before_turn_start_seq: 5 },
      { task_id: 't', data: [{ turn_start_seq: 4 }], next_before_turn_start_seq: null },
    ];
    const { client, calls } = mockClient((_r, i) => json(pages[i]));
    const turns = await collect(client.items('list_code_task_turns', { task_id: 't' }));
    assert.equal(turns.length, 2);
    assert.equal(calls[1]!.url.searchParams.get('before_turn_start_seq'), '5');
    assert.equal(calls[1]!.url.pathname, '/v1/code/tasks/t/turns');
  });

  it('starts from a cursor the caller passes', async () => {
    const { client, calls } = mockClient(() => json({ data: [], next_cursor: null }));
    await collect(client.pages('list_verify_jobs', { repository_id: 'r', cursor: 'resume' }));
    assert.equal(calls[0]!.url.searchParams.get('cursor'), 'resume');
  });

  it('stops if the server repeats a cursor', async () => {
    const { client, calls } = mockClient(() => json({ data: [{}], next_cursor: 'same' }));
    await collect(client.pages('list_triage_teams'));
    assert.equal(calls.length, 2);
  });

  it('respects maxPages', async () => {
    let n = 0;
    const { client, calls } = mockClient(() => json({ data: [{}], next_cursor: `c${++n}` }));
    const pages = await collect(client.pages('list_verify_repositories', {}, { maxPages: 3 }));
    assert.equal(pages.length, 3);
    assert.equal(calls.length, 3);
  });

  it('keeps the org selector on every page', async () => {
    const pages = [
      { organizations: [{}], next_cursor: 'x' },
      { organizations: [{}], next_cursor: null },
    ];
    const { client, calls } = mockClient((_r, i) => json(pages[i]), { org: { org_name: 'acme' } });
    await collect(client.pages('list_code_tasks'));
    assert.equal(calls[0]!.url.searchParams.get('org_name'), 'acme');
  });
});

describe('page-number pagination', () => {
  it('uses pagination.has_next_page (audit logs)', async () => {
    const pages = [
      { data: [{ id: 1 }], pagination: { page: 1, has_next_page: true } },
      { data: [{ id: 2 }], pagination: { page: 2, has_next_page: false } },
    ];
    const { client, calls } = mockClient((_r, i) => json(pages[i]));
    const rows = await collect(client.items('audit-logs-list', { page_size: 1 }));
    assert.equal(rows.length, 2);
    assert.deepEqual(calls.map((c) => c.url.searchParams.get('page')), ['1', '2']);
  });

  it('uses pagination.totalPages (security findings)', async () => {
    const { client, calls } = mockClient((r) => json({ items: [{}], pagination: { page: Number(r.url.searchParams.get('page')), pageSize: 1, total: 3, totalPages: 3 } }));
    const rows = await collect(client.items('list_security_findings'));
    assert.equal(rows.length, 3);
    assert.equal(calls.length, 3);
  });

  it('uses pagination.hasNextPage (security scans)', async () => {
    const pages = [
      { data: [{}], pagination: { hasNextPage: true } },
      { data: [{}], pagination: { hasNextPage: false } },
    ];
    const { client, calls } = mockClient((_r, i) => json(pages[i]));
    await collect(client.pages('list_security_scans'));
    assert.equal(calls.length, 2);
  });

  it('uses nextPage (architecture repositories)', async () => {
    const pages = [
      { repositories: [{}], nextPage: 2 },
      { repositories: [{}], nextPage: null },
    ];
    const { client, calls } = mockClient((_r, i) => json(pages[i]));
    await collect(client.pages('list_architecture_repositories'));
    assert.deepEqual(calls.map((c) => c.url.searchParams.get('page')), ['1', '2']);
  });

  it('uses total (member budgets) and totalCount (learnings)', async () => {
    const budget = mockClient(() => json({ data: [{}, {}], total: 4, page: 1, page_size: 2 }));
    assert.equal((await collect(budget.client.items('list_usage_budget_members'))).length, 4);
    assert.equal(budget.calls.length, 2);
    const learn = mockClient(() => json({ items: [{}], totalCount: 2 }));
    assert.equal((await collect(learn.client.items('list_learnings'))).length, 2);
    assert.deepEqual(learn.calls.map((c) => c.url.searchParams.get('page')), ['1', '2']);
  });

  it('starts the Verify bug history at page 0, as its schema says', async () => {
    const pages = [
      { total: 2, affected_run_count: 1, observations: [{}] },
      { total: 2, affected_run_count: 1, observations: [{}] },
    ];
    const { client, calls } = mockClient((_r, i) => json(pages[i]));
    await collect(client.pages('get_verify_bug_history', { repository_id: 'r', bug_id: 'b' }));
    assert.deepEqual(calls.map((c) => c.url.searchParams.get('page')), ['0', '1']);
  });

  it('stops on an empty page', () => {
    assert.equal(nextPageNumber({ data: [] }, 3, 1, 10, 0), undefined);
    assert.equal(nextPageNumber({ data: [{}] }, 3, 1, 10, 1), 4);
  });
});

describe('pagination typing', () => {
  it('rejects operations without pagination at runtime', async () => {
    const { client } = mockClient();
    await assert.rejects(collect((client.pages as (id: string) => AsyncIterable<unknown>)('get_me')), /not paginated/);
  });
});
