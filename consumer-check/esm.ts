// Compiled against dist/esm with plain NodeNext settings, the way a downstream project would see it.
import { CodeRabbit, CodeRabbitRateLimitError } from '../dist/esm/index.js';
import type { OperationOutputs } from '../dist/esm/index.js';

const client = new CodeRabbit({ apiKey: 'k', region: 'eu', org: { org_name: 'acme' } });

export async function run(): Promise<void> {
  const me: OperationOutputs['get_me'] = await client.identity.getMe();
  const principal: 'api_key' | 'user' = me.principal.type;
  const repos = await client.repositories.listRepositories({ limit: 10 });
  const first: string | undefined = repos.data[0]?.full_name;
  for await (const pr of client.items('list_repository_pull_requests', { repository_id: '1', state: 'open' })) {
    const n: number = pr.number;
    void n;
  }
  try {
    await client.reviews.requestPullRequestReview({ repository_id: '1', pull_request_number: 2 });
  } catch (err) {
    if (err instanceof CodeRabbitRateLimitError) void err.retryAfterMs;
  }
  void principal;
  void first;
}
