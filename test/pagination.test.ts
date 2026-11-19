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

  it('follows next_cursor through empty pages (list_repositories)', async () => {
    const pages = [
      { data: [], next_cursor: 't2' },
      { data: [{ id: 'r1' }], next_cursor: null },
    ];
    const { client, calls } = mockClient((_r, i) => json(pages[i]));
    const repos = await collect(client.items('list_repositories', { limit: 50 }));
    assert.equal(repos.length, 1);
    assert.equal(calls[1]!.url.searchParams.get('cursor'), 't2');
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

  // These lists paged by number until the November 2026 spec, which moved
  // them to cursor and next_cursor.
  for (const [op, key, input] of [
    ['list_security_findings', 'items', {}],
    ['list_security_scans', 'data', {}],
    ['list_architecture_repositories', 'repositories', {}],
    ['list_usage_budget_members', 'data', {}],
    ['list_learnings', 'items', {}],
    ['get_verify_bug_history', 'observations', { repository_id: 'r', bug_id: 'b' }],
  ] as const) {
    it(`follows next_cursor (${op})`, async () => {
      const pages = [
        { [key]: [{}], total: 2, next_cursor: 'c2' },
        { [key]: [{}], total: 2, next_cursor: null },
      ];
      const { client, calls } = mockClient((_r, i) => json(pages[i]));
      await collect(client.pages(op as never, input as never));
      assert.equal(calls.length, 2);
      assert.equal(calls[0]!.url.searchParams.get('cursor'), null);
      assert.equal(calls[1]!.url.searchParams.get('cursor'), 'c2');
      assert.equal(calls[1]!.url.searchParams.get('page'), null);
    });
  }

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
