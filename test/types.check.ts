// Compile-time checks. This file is type-checked by `npm run typecheck` and never executed.
import { CodeRabbit } from '../src/index.ts';
import type { OperationInputs, OperationOutputs, PageItems } from '../src/index.ts';

declare const client: CodeRabbit;

export async function checks(): Promise<void> {
  // Path parameters are required.
  // @ts-expect-error repository_id and pull_request_number are missing
  await client.reviews.requestPullRequestReview({});

  // Required query parameters are required.
  // @ts-expect-error start_date and end_date are missing
  await client.metrics.reviewMetrics({});
  await client.metrics.reviewMetrics({ start_date: '2026-01-01', end_date: '2026-01-31' });

  // Operations without required input can be called with no arguments.
  await client.identity.getMe();
  await client.call('get_me');

  // Enum values are checked.
  // @ts-expect-error "sideways" is not a pull-request state
  await client.pullRequests.listRepositoryPullRequests({ repository_id: '1', state: 'sideways' });

  // Required request bodies are required.
  // @ts-expect-error body is missing
  await client.code.createCodeTask({});

  // The API key header is supplied by the client, not by callers.
  // @ts-expect-error not an input of list-users
  await client.users.listUsers({ 'x-coderabbitai-api-key': 'k' });

  // Output types come from the spec.
  const me = await client.identity.getMe();
  const kind: 'api_key' | 'user' = me.principal.type;
  const csvOrJson: OperationOutputs['bug-scan-findings-list'] = await client.bugScan.bugScanFindingsList({ repo_id: 'r' });
  if (typeof csvOrJson === 'string') csvOrJson.split('\n');
  const deleted: undefined = await client.learnings.learningsDelete({ learning_id: 'l' });

  // call() is typed by operationId.
  // @ts-expect-error unknown operation
  await client.call('not_an_operation');
  const pr = await client.call('get_repository_pull_request', { repository_id: '1', pull_request_number: 2 });
  const sha: string = pr.head_sha;

  // Pagination only accepts paginated operations and yields their item type.
  for await (const user of client.items('list-users')) {
    const u: PageItems['list-users'] = user;
    void u;
  }
  // @ts-expect-error get_me is not paginated
  client.pages('get_me');

  const input: OperationInputs['get_code_autofix'] = { target: { type: 'task', taskId: 't1' } };
  void input;
  void kind;
  void deleted;
  void sha;
}
