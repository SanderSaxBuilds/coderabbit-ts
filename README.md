# coderabbit-ts

A typed TypeScript client for the [CodeRabbit Platform API](https://docs.coderabbit.ai/api/platform-api), generated from the OpenAPI spec CodeRabbit publishes at `https://docs.coderabbit.ai/openapi.json`.

- All 175 operations in the spec, grouped into 24 namespaces, each with typed input and output.
- Uses `fetch`. No runtime dependencies.
- ESM and CommonJS builds with type declarations.
- US and EU base URLs.
- Typed errors that read every error body shape the spec uses.
- Retries on 429 and 5xx that honour `Retry-After` and `error.retry_after`.
- Pagination helpers for the 39 list operations, across the four cursor styles and the page-number styles the spec uses.
- `AbortSignal` support and a per-attempt timeout.

Independent project, not affiliated with CodeRabbit.

## Install

The package is not on npm. Install it from GitHub, which builds it on install:

```sh
npm install github:SanderSaxBuilds/coderabbit-ts
```

Node 18 or newer, or any runtime with a global `fetch`.

## Quick start

```ts
import { CodeRabbit } from 'coderabbit-ts';

const cr = new CodeRabbit({ apiKey: process.env.CODERABBIT_API_KEY });

const me = await cr.identity.getMe();
console.log(me.principal.type, me.scope);

// Request a review of the current head of a pull request (needs an agentic key).
const accepted = await cr.reviews.requestPullRequestReview({
  repository_id: '12345678',
  pull_request_number: 42,
});

// Read the review status afterwards.
const review = await cr.reviews.getPullRequestReview({ repository_id: '12345678', pull_request_number: 42 });

// Walk every open pull request in a repository.
for await (const pr of cr.items('list_repository_pull_requests', { repository_id: '12345678', state: 'open' })) {
  console.log(pr.number, pr.title);
}
```

CommonJS works the same way:

```js
const { CodeRabbit } = require('coderabbit-ts');
```

## Options

```ts
new CodeRabbit({
  apiKey: '...',            // default: process.env.CODERABBIT_API_KEY
  region: 'us',             // 'us' -> https://api.coderabbit.ai, 'eu' -> https://api.eu.coderabbit.ai
  baseUrl: undefined,       // full origin override, for a proxy
  org: { org_name: 'acme' },// default organization selector for workspace keys
  timeoutMs: 60_000,        // per attempt
  maxRetries: 2,
  maxRetryDelayMs: 60_000,  // a longer Retry-After stops retrying and throws
  baseRetryDelayMs: 500,    // backoff start when the server gives no Retry-After
  headers: {},              // extra headers on every request
  fetch: globalThis.fetch,
});
```

Every method also takes per-request options as its second argument: `signal`, `timeoutMs`, `maxRetries`, `headers` and `retryUnsafe`.

### Organization selection

Organization keys select their own organization. Workspace keys need `org_name` or `org_id` on each request, and the spec puts that selector in the query string for reads and in the JSON body for most writes. Set `org` once on the client and it is added to every operation that accepts it, in the place that operation's schema declares. A selector you pass on a call wins over the default. Passing both `org_id` and `org_name` throws before the request is sent, since the docs say the API answers that with `400 invalid_request`.

The docs say `org_name` is not yet available on the EU API, so use `org_id` there.

## Calling operations

Each operation is a method named after its `operationId` in camelCase, inside a namespace taken from its tag:

```ts
await cr.code.createCodeTask({ body: { /* CreateCodeTask body */ } });
await cr.code.getCodeTaskPlan({ task_id: 't_1', version: 3 });
await cr.security.listSecurityFindings({ severity: ['critical', 'high'], page_size: 50 });
await cr.learnings.updateLearning({ learning_id: 'l_1', body: { /* ... */ } });
```

The input is one object. Path, query and header parameters go in by their spec names, and the request body goes under `body`. The client sends each parameter where the spec says it lives, so callers do not need to know which is which.

The same operations are reachable by `operationId`, which helps when you build calls from data:

```ts
await cr.call('get_repository_pull_request', { repository_id: '1', pull_request_number: 2, include: ['checks', 'threads'] });

const { data, response } = await cr.callWithResponse('get_usage');
console.log(response.status, response.headers.get('x-ratelimit-remaining'), response.attempts);
```

Return values are the parsed body. JSON comes back as the typed object, `text/csv` exports as a string, the Verify evidence download as an `ArrayBuffer`, and `204` responses as `undefined`.

The generated types are exported too: `OperationInputs`, `OperationOutputs`, `PageItems`, and the raw `paths`, `operations` and `components` types.

## Pagination

`pages()` yields each page body and `items()` yields the items inside them. Both take the same input as the operation and keep it for every page.

```ts
for await (const user of cr.items('list-users', { seat_filter: 'assigned' })) { /* ... */ }

for await (const page of cr.pages('list_triage_changes', { view: 'mine' }, { maxPages: 5 })) { /* ... */ }
```

The spec uses several pagination styles, and each operation's style is read from the spec at generation time:

| Style | Request parameter | Response field | Example operations |
| - | - | - | - |
| cursor | `cursor` | `next_cursor` | `list-users`, `list_triage_changes`, `list_verify_jobs` |
| cursor, camelCase | `cursor` | `nextCursor` | `list_triage_rules`, `list_connection_requests` |
| page token | `page_token` | `next_page_token` | `list_repositories`, `list_code_tasks` |
| turn sequence | `before_turn_start_seq` | `next_before_turn_start_seq` | `list_code_task_turns` |
| page number | `page` | `pagination.has_next_page`, `pagination.totalPages`, `nextPage`, `total` or `totalCount` | `audit-logs-list`, `list_security_findings`, `list_learnings` |

Cursor walks stop when the cursor is `null` and keep going through empty pages, as the repository docs ask. Page-number walks stop at the last page or on an empty page. Page numbering starts where the spec says, which is 0 for `get_verify_bug_history` and 1 elsewhere. `list_automation_runs` pages by `offset` over two arrays, so it has no helper. Pass `offset` yourself.

## Errors

Every non-2xx response throws a `CodeRabbitApiError` subclass:

| Status | Class |
| - | - |
| 400, 413 | `CodeRabbitBadRequestError` |
| 401 | `CodeRabbitAuthenticationError` |
| 402 | `CodeRabbitPaymentRequiredError` |
| 403 | `CodeRabbitPermissionError` |
| 404 | `CodeRabbitNotFoundError` |
| 409, 412 | `CodeRabbitConflictError` |
| 410 | `CodeRabbitGoneError` |
| 429 | `CodeRabbitRateLimitError` |
| 5xx | `CodeRabbitServerError` |

Each error carries `status`, `code`, `serverMessage`, `body` (parsed JSON or text), `rawBody`, `headers`, `retryAfterMs`, `rateLimit` (from the `X-RateLimit-*` headers), `requestId`, `operationId` and `attempts`. The spec has three error body shapes and all three are read:

```jsonc
{ "error": { "code": "forbidden", "message": "...", "retry_after": 30 } }   // shared Platform API operations
{ "errors": [ { "code": "INVALID_PARAMETER", "message": "..." } ] }       // report and metrics routes
{ "code": "UNAUTHORIZED", "message": "..." }                              // report.generate examples
```

```ts
import { CodeRabbitPermissionError, CodeRabbitRateLimitError } from 'coderabbit-ts';

try {
  await cr.reviews.requestPullRequestReview({ repository_id: '1', pull_request_number: 2 });
} catch (err) {
  if (err instanceof CodeRabbitPermissionError && err.code === 'forbidden') {
    // A user key cannot request reviews, an agentic key is needed.
  }
}
```

Network failures throw `CodeRabbitConnectionError` with the original error as `cause`. Timeouts throw `CodeRabbitTimeoutError`. An abort from your own signal rejects with the signal's reason.

## Retries, timeouts and cancellation

- `429` is retried for every method, because a rate-limited request was not processed.
- `5xx` (except `501`), network errors and timeouts are retried for `GET`, `PUT` and `DELETE`.
- `POST` and `PATCH` are not retried after a `5xx` or network error unless you pass `retryUnsafe: true`, or the body carries the spec's `client_operation_id` idempotency key (coding turns, plan revisions and question answers). The docs say patch delivery has no idempotency key and should be checked by reading the task before retrying.
- The wait is `Retry-After` (seconds or HTTP date) when present, then `error.retry_after` from the body, then exponential backoff with jitter.
- `timeoutMs` applies to each attempt, including reading the body. `report-generate` defaults to 10 minutes because its description says it can take that long.
- A `signal` cancels the request and any retry wait.

## How it maps to the spec

The spec is stored byte for byte in `spec/openapi.json.gz` (sha256 `52e1a6d7f0df4ca1182f38c45680ab49f4d060d5d287eca59963d1aacbf7fdd6`, 3,334,355 bytes uncompressed, fetched 13 November 2026). `npm run generate` reads it and writes three files to `src/generated/`:

- `schema.ts`, every path, operation and component schema as types, produced by `openapi-typescript`.
- `operations.ts`, a runtime table with each operation's method, path, parameter locations and array styles, body requirement, organization selector location, success content types and pagination style, plus the `OperationInputs` and `OperationOutputs` types built from `schema.ts`.
- `resources.ts`, the namespaced methods.

Generated files are not committed. They are rebuilt by `npm run build`, `npm test` and `npm run typecheck`, and on install. The generator stops with an error if the spec has an operation it cannot place, a parameter name used twice, or two operations that would get the same method name, so a spec update cannot silently drop an endpoint.

To move to a newer spec, run `npm run update-spec`, then `npm run check`.

| Spec | Client |
| - | - |
| `servers[0].url` | `region: 'us'` |
| `https://api.eu.coderabbit.ai` from the docs | `region: 'eu'` |
| `securitySchemes.ApiKeyAuth` (`x-coderabbitai-api-key`) | `apiKey` option, sent on every request |
| `tags[0]` | namespace (three untagged operations are placed with their doc group) |
| `operationId` | method name in camelCase, and the key for `call()`, `pages()` and `items()` |
| path, query and header parameters | top-level input fields with the same names |
| `requestBody` | `body` input field |
| `style: form`, `explode: false` arrays | comma-joined |
| `style: form`, `explode: true` arrays | repeated parameter |
| `style: deepObject` (`get_code_autofix` target) | `target[type]=...&target[taskId]=...` |
| 2xx `content` | return type |

## Spec and docs differences

These came up while building the client. Each one was checked against the spec file above and the docs pages on 13 November 2026.

1. **EU base URL.** The docs ([Platform API](https://docs.coderabbit.ai/api/platform-api), [API overview](https://docs.coderabbit.ai/api/index), [authentication](https://docs.coderabbit.ai/api/platform-authentication)) give `https://api.eu.coderabbit.ai` for EU organizations. The spec's `servers` lists only `https://api.coderabbit.ai`, so a client generated from the spec alone cannot reach the EU region.
2. **What `org_id` accepts.** The authentication page says `org_id` is a Git-provider ID, that `GET /me` returns a CodeRabbit organization ID in `scope.id`, and not to interchange them. In the spec, the `org_id` description on 71 operations says it accepts either the Git-provider ID or the CodeRabbit organization ID (`scope.id`), while 9 older operations describe it as the Git-provider ID only.
3. **`Retry-After` on 429.** The docs tell REST callers to use the `Retry-After` header and `error.retry_after`. The spec declares a `Retry-After` header on the 429 response of 6 of its 175 operations. The other shared operations declare only `error.retry_after` in the body. This client reads both.
4. **report.generate error examples.** The 401, 403 and 429 examples are `{ "message", "code" }`, but the `Error` schema they reference requires an `errors` array.
5. **report.generate deprecation and path.** Its description starts with "DEPRECATED", but the operation has no `deprecated: true`, so generated clients and reference pages do not flag it. It also lives under `/api/v1`, while the docs give the REST base as `https://api.coderabbit.ai/v1`.
6. **Pagination.** The docs say token-based lists continue until the token is `null` and other operations use page numbers. The spec also has an offset cursor (`list_automation_runs`, `next_offset`) and a turn-sequence cursor (`list_code_task_turns`, `list_code_task_questions`). Cursor fields are named `next_cursor`, `nextCursor`, `next_page_token` and `nextPage` in different places, and `get_verify_bug_history` counts pages from 0 while the other page-numbered lists start at 1.
7. **API key declared twice.** 12 older operations list `x-coderabbitai-api-key` as a required header parameter in addition to the global security scheme. Generators then ask the caller for the key on those operations only. `PUT /v1/users` does not repeat it.
8. **Untagged operations.** `report-generate`, `review-metrics` and `change-roles` have no tag, while the docs file them under reports, metrics data and roles.

## Methods

<!-- methods:start -->
175 operations, 24 namespaces. Generated from the spec by `npm run generate`.

### `reports`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `reports.reportGenerate` (deprecated) | `POST /api/v1/report.generate` | `report-generate` |  |
| `reports.listReports` | `GET /v1/reports` | `list_reports` |  |
| `reports.createReport` | `POST /v1/reports` | `create_report` |  |
| `reports.getReport` | `GET /v1/reports/{report_id}` | `get_report` |  |
| `reports.updateReport` | `PUT /v1/reports/{report_id}` | `update_report` |  |
| `reports.deleteReport` | `DELETE /v1/reports/{report_id}` | `delete_report` |  |
| `reports.setReportStatus` | `PATCH /v1/reports/{report_id}` | `set_report_status` |  |

### `metrics`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `metrics.reviewMetrics` | `GET /v1/metrics/reviews` | `review-metrics` | `cursor` |
| `metrics.mcpMetrics` | `GET /v1/metrics/mcp` | `mcp-metrics` | `cursor` |
| `metrics.reviewCommentMetrics` | `GET /v1/metrics/review-comments` | `review-comment-metrics` | `cursor` |

### `users`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `users.listUsers` | `GET /v1/users` | `list-users` | `cursor` |
| `users.addUsers` | `PUT /v1/users` | `add-users` |  |
| `users.manageSeats` | `POST /v1/users/seats` | `manage-seats` |  |
| `users.updateSeatAssignmentMode` | `POST /v1/users/seats/assignment` | `update-seat-assignment-mode` |  |
| `users.changeRoles` | `POST /v1/users/roles` | `change-roles` |  |

### `auditLogs`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `auditLogs.auditLogsList` | `GET /v1/audit-logs` | `audit-logs-list` | `page` from 1 |

### `learnings`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `learnings.learningsList` | `GET /v1/learnings` | `learnings-list` | `cursor` |
| `learnings.learningsDelete` | `DELETE /v1/learnings/{learning_id}` | `learnings-delete` |  |
| `learnings.learningsUpdate` | `PATCH /v1/learnings/{learning_id}` | `learnings-update` |  |
| `learnings.listLearnings` | `GET /v1/knowledge/learnings` | `list_learnings` | `page` from 1 |
| `learnings.createLearnings` | `POST /v1/knowledge/learnings` | `create_learnings` |  |
| `learnings.getLearning` | `GET /v1/knowledge/learnings/{learning_id}` | `get_learning` |  |
| `learnings.deleteLearning` | `DELETE /v1/knowledge/learnings/{learning_id}` | `delete_learning` |  |
| `learnings.updateLearning` | `PATCH /v1/knowledge/learnings/{learning_id}` | `update_learning` |  |
| `learnings.getLearningStatistics` | `GET /v1/knowledge/learnings/statistics` | `get_learning_statistics` |  |
| `learnings.getLearningFilters` | `GET /v1/knowledge/learnings/filters` | `get_learning_filters` |  |
| `learnings.exportLearnings` | `GET /v1/knowledge/learnings/export` | `export_learnings` |  |

### `organizations`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `organizations.organizationsList` | `GET /v1/organizations` | `organizations-list` | `cursor` |
| `organizations.organizationRepositoriesList` | `GET /v1/organizations/{organization_id}/repositories` | `organization-repositories-list` | `cursor` |

### `security`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `security.securityScansCodeList` | `GET /v1/security/scans/code` | `security-scans-code-list` | `cursor` |
| `security.exportSecuritySbom` | `GET /v1/security/sbom/export` | `export_security_sbom` |  |
| `security.listSecurityFindings` | `GET /v1/security/findings` | `list_security_findings` | `page` from 1 |
| `security.listSecurityDependencies` | `GET /v1/security/dependencies` | `list_security_dependencies` | `page` from 1 |
| `security.listSecuritySbom` | `GET /v1/security/sbom` | `list_security_sbom` | `page` from 1 |
| `security.listSecurityScans` | `GET /v1/security/scans` | `list_security_scans` | `page` from 1 |
| `security.startSecurityScans` | `POST /v1/security/scans` | `start_security_scans` |  |
| `security.getSecurityScan` | `GET /v1/security/repositories/{repository_id}/scans/{scan_id}` | `get_security_scan` |  |
| `security.getSecurityScanQuote` | `GET /v1/security/repositories/{repository_id}/scans/quote` | `get_security_scan_quote` |  |
| `security.fixSecurityFinding` | `POST /v1/security/repositories/{repository_id}/findings/{finding_id}/fix` | `fix_security_finding` |  |
| `security.dismissSecurityFinding` | `POST /v1/security/repositories/{repository_id}/findings/{finding_id}/dismiss` | `dismiss_security_finding` |  |
| `security.reopenSecurityFinding` | `POST /v1/security/repositories/{repository_id}/findings/{finding_id}/reopen` | `reopen_security_finding` |  |
| `security.getSecurityFinding` | `GET /v1/security/repositories/{repository_id}/findings/{finding_id}` | `get_security_finding` |  |
| `security.getSecuritySecretFinding` | `GET /v1/security/repositories/{repository_id}/secrets/{finding_id}` | `get_security_secret_finding` |  |
| `security.getSecurityDependency` | `GET /v1/security/repositories/{repository_id}/dependencies/{dependency_id}` | `get_security_dependency` |  |
| `security.listSecuritySecretFindings` | `GET /v1/security/secrets` | `list_security_secret_findings` | `page` from 1 |
| `security.getSecurityRuntimeValidation` | `GET /v1/security/repositories/{repository_id}/validations/{validation_id}` | `get_security_runtime_validation` |  |
| `security.listSecurityRuntimeValidations` | `GET /v1/security/repositories/{repository_id}/validations` | `list_security_runtime_validations` | `cursor` |
| `security.getSecurityRuntimeValidationCapability` | `GET /v1/security/repositories/{repository_id}/findings/{finding_id}/validation-capability` | `get_security_runtime_validation_capability` |  |

### `bugScan`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `bugScan.bugScanFindingsList` | `GET /v1/bug-scan/findings` | `bug-scan-findings-list` | `cursor` |

### `repositories`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `repositories.linkedRepositoriesList` | `GET /v1/linked-repositories` | `linked-repositories-list` | `cursor` |
| `repositories.listRepositories` | `GET /v1/repositories` | `list_repositories` | `page_token` |
| `repositories.getRepository` | `GET /v1/repositories/{repository_id}` | `get_repository` |  |

### `reviews`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `reviews.getPullRequestReview` | `GET /v1/repositories/{repository_id}/pull-requests/{pull_request_number}/review` | `get_pull_request_review` |  |
| `reviews.requestPullRequestReview` | `POST /v1/repositories/{repository_id}/pull-requests/{pull_request_number}/review` | `request_pull_request_review` |  |
| `reviews.getPullRequestReviewSummary` | `GET /v1/repositories/{repository_id}/pull-requests/{pull_request_number}/review/summary` | `get_pull_request_review_summary` |  |
| `reviews.getPullRequestChangeStack` | `GET /v1/repositories/{repository_id}/pull-requests/{pull_request_number}/change-stack` | `get_pull_request_change_stack` |  |
| `reviews.getPullRequestChangeStackLayerDiff` | `GET /v1/repositories/{repository_id}/pull-requests/{pull_request_number}/change-stack/groups/{group_id}/layers/{layer_id}/diff` | `get_pull_request_change_stack_layer_diff` | `page_token` |
| `reviews.listPullRequestReviewThreadComments` | `GET /v1/repositories/{repository_id}/pull-requests/{pull_request_number}/review-threads/{thread_id}/comments` | `list_pull_request_review_thread_comments` | `page_token` |

### `pullRequests`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `pullRequests.listRepositoryPullRequests` | `GET /v1/repositories/{repository_id}/pull-requests` | `list_repository_pull_requests` | `page_token` |
| `pullRequests.getRepositoryPullRequest` | `GET /v1/repositories/{repository_id}/pull-requests/{pull_request_number}` | `get_repository_pull_request` |  |

### `identity`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `identity.getMe` | `GET /v1/me` | `get_me` |  |

### `usage`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `usage.getCredits` | `GET /v1/credits` | `get_credits` |  |
| `usage.getUsage` | `GET /v1/usage` | `get_usage` |  |
| `usage.getUsageBudget` | `GET /v1/usage/budget` | `get_usage_budget` |  |
| `usage.listUsageBudgetMembers` | `GET /v1/usage/budget/members` | `list_usage_budget_members` | `page` from 1 |

### `architecture`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `architecture.getArchitectureCapabilities` | `GET /v1/knowledge/architecture/capabilities` | `get_architecture_capabilities` |  |
| `architecture.listArchitectureRepositories` | `GET /v1/knowledge/architecture/repositories` | `list_architecture_repositories` | `page` from 1 |
| `architecture.getArchitectureTree` | `GET /v1/knowledge/architecture/tree` | `get_architecture_tree` |  |
| `architecture.getArchitectureDocument` | `GET /v1/knowledge/architecture/document` | `get_architecture_document` |  |

### `triage`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `triage.listTriageChanges` | `GET /v1/triage/changes` | `list_triage_changes` | `cursor` |
| `triage.getTriageChange` | `GET /v1/triage/changes/{id}` | `get_triage_change` |  |
| `triage.listTriageChangeHistory` | `GET /v1/triage/changes/{id}/history` | `list_triage_change_history` | `cursor` |
| `triage.listTriageTeams` | `GET /v1/triage/teams` | `list_triage_teams` | `cursor` |
| `triage.setTriageChangePriority` | `PUT /v1/triage/changes/{id}/priority` | `set_triage_change_priority` |  |

### `triageRules`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `triageRules.listTriageRules` | `GET /v1/triage/rules` | `list_triage_rules` | `cursor` |
| `triageRules.createTriageRule` | `POST /v1/triage/rules` | `create_triage_rule` |  |
| `triageRules.getTriageRule` | `GET /v1/triage/rules/{ruleId}` | `get_triage_rule` |  |
| `triageRules.updateTriageRule` | `PUT /v1/triage/rules/{ruleId}` | `update_triage_rule` |  |
| `triageRules.deleteTriageRule` | `DELETE /v1/triage/rules/{ruleId}` | `delete_triage_rule` |  |
| `triageRules.previewTriageRule` | `POST /v1/triage/rules/preview` | `preview_triage_rule` |  |
| `triageRules.transitionTriageRule` | `POST /v1/triage/rules/{ruleId}/transition` | `transition_triage_rule` |  |
| `triageRules.listTriageRuleExecutions` | `GET /v1/triage/rules/{ruleId}/executions` | `list_triage_rule_executions` | `cursor` |

### `knowledge`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `knowledge.listKnowledgeConnections` | `GET /v1/knowledge/connected-repositories` | `list_knowledge_connections` |  |
| `knowledge.connectKnowledgeRepository` | `POST /v1/knowledge/connected-repositories` | `connect_knowledge_repository` |  |
| `knowledge.reindexKnowledgeRepository` | `POST /v1/knowledge/connected-repositories/{repository_id}/reindex` | `reindex_knowledge_repository` |  |
| `knowledge.disconnectKnowledgeRepository` | `DELETE /v1/knowledge/connected-repositories/{repository_id}` | `disconnect_knowledge_repository` |  |

### `automations`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `automations.listAutomations` | `GET /v1/automations` | `list_automations` |  |
| `automations.createAutomation` | `POST /v1/automations` | `create_automation` |  |
| `automations.getAutomation` | `GET /v1/automations/{automation_id}` | `get_automation` |  |
| `automations.updateAutomation` | `PUT /v1/automations/{automation_id}` | `update_automation` |  |
| `automations.listAutomationRuns` | `GET /v1/automations/{automation_id}/runs` | `list_automation_runs` |  |
| `automations.commandAutomation` | `POST /v1/automations/{automation_id}/commands` | `command_automation` |  |

### `configuration`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `configuration.getOrganizationConfiguration` | `GET /v1/configuration/organization` | `get_organization_configuration` |  |
| `configuration.setOrganizationConfiguration` | `PUT /v1/configuration/organization` | `set_organization_configuration` |  |
| `configuration.getWorkspaceConfiguration` | `GET /v1/configuration/workspace` | `get_workspace_configuration` |  |
| `configuration.getEffectiveRepositoryConfiguration` | `GET /v1/repositories/{repository_id}/configuration/effective` | `get_effective_repository_configuration` |  |
| `configuration.getRepositoryConfiguration` | `GET /v1/repositories/{repository_id}/configuration` | `get_repository_configuration` |  |
| `configuration.setRepositoryConfiguration` | `PUT /v1/repositories/{repository_id}/configuration` | `set_repository_configuration` |  |
| `configuration.previewRepositoryConfiguration` | `POST /v1/repositories/{repository_id}/configuration/preview` | `preview_repository_configuration` |  |
| `configuration.getRepositoryConfigurationSource` | `GET /v1/repositories/{repository_id}/configuration/source` | `get_repository_configuration_source` |  |
| `configuration.setRepositoryConfigurationSource` | `PUT /v1/repositories/{repository_id}/configuration/source` | `set_repository_configuration_source` |  |
| `configuration.getWorkspaceConfigurationDefaults` | `GET /v1/configuration/workspace-defaults` | `get_workspace_configuration_defaults` |  |
| `configuration.setWorkspaceConfigurationDefaults` | `PUT /v1/configuration/workspace-defaults` | `set_workspace_configuration_defaults` |  |

### `connections`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `connections.listConnections` | `GET /v1/connections` | `list_connections` |  |
| `connections.createConnection` | `POST /v1/connections` | `create_connection` |  |
| `connections.listConnectionRequests` | `GET /v1/connections/requests` | `list_connection_requests` | `cursor` |
| `connections.getConnectionRequest` | `GET /v1/connections/requests/{intent}` | `get_connection_request` |  |
| `connections.submitConnectionRequest` | `POST /v1/connections/requests/{intent}` | `submit_connection_request` |  |
| `connections.completeConnectionRequests` | `POST /v1/connections/{connectionId}/complete-requests` | `complete_connection_requests` |  |
| `connections.getConnection` | `GET /v1/connections/{connectionId}` | `get_connection` |  |
| `connections.updateConnection` | `PUT /v1/connections/{connectionId}` | `update_connection` |  |
| `connections.deleteConnection` | `DELETE /v1/connections/{connectionId}` | `delete_connection` |  |
| `connections.patchConnectionMetadata` | `PATCH /v1/connections/{connectionId}` | `patch_connection_metadata` |  |
| `connections.testConnection` | `POST /v1/connections/test` | `test_connection` |  |
| `connections.discoverConnectionMcpTools` | `POST /v1/connections/mcp/tools` | `discover_connection_mcp_tools` |  |

### `code`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `code.listCodeTasks` | `GET /v1/code/tasks` | `list_code_tasks` | `page_token` |
| `code.createCodeTask` | `POST /v1/code/tasks` | `create_code_task` |  |
| `code.getCodeTask` | `GET /v1/code/tasks/{task_id}` | `get_code_task` |  |
| `code.getCodeTaskPlan` | `GET /v1/code/tasks/{task_id}/plan` | `get_code_task_plan` |  |
| `code.setCodeTaskPlanApproval` | `PUT /v1/code/tasks/{task_id}/plan/approval` | `set_code_task_plan_approval` |  |
| `code.getCodeTaskPatch` | `GET /v1/code/tasks/{task_id}/patch` | `get_code_task_patch` |  |
| `code.getCodeTaskQueue` | `GET /v1/code/tasks/{task_id}/queue` | `get_code_task_queue` |  |
| `code.deliverCodeTask` | `POST /v1/code/tasks/{task_id}/delivery` | `deliver_code_task` |  |
| `code.getCodeAutofix` | `GET /v1/code/autofix` | `get_code_autofix` |  |
| `code.setCodeAutofix` | `POST /v1/code/autofix/commands` | `set_code_autofix` |  |
| `code.listCodeTaskTurns` | `GET /v1/code/tasks/{task_id}/turns` | `list_code_task_turns` | `before_turn_start_seq` |
| `code.createCodeTaskTurn` | `POST /v1/code/tasks/{task_id}/turns` | `create_code_task_turn` |  |
| `code.getCodeTaskTurn` | `GET /v1/code/tasks/{task_id}/turns/{turn_start_seq}` | `get_code_task_turn` |  |
| `code.reviseCodeTaskPlan` | `POST /v1/code/tasks/{task_id}/plan/revisions` | `revise_code_task_plan` |  |
| `code.implementCodeTaskPlan` | `POST /v1/code/tasks/{task_id}/plan/implementation` | `implement_code_task_plan` |  |
| `code.listCodeTaskQuestions` | `GET /v1/code/tasks/{task_id}/questions` | `list_code_task_questions` | `before_turn_start_seq` |
| `code.answerCodeTaskQuestion` | `POST /v1/code/tasks/{task_id}/questions/{interaction_id}/answers` | `answer_code_task_question` |  |
| `code.cancelCodeTaskTurn` | `POST /v1/code/tasks/{task_id}/cancel` | `cancel_code_task_turn` |  |
| `code.listCodeTaskPlanComments` | `GET /v1/code/tasks/{task_id}/plan/comments` | `list_code_task_plan_comments` |  |
| `code.replyCodeTaskPlanCommentThread` | `POST /v1/code/tasks/{task_id}/plan/comments/threads/{thread_id}/replies` | `reply_code_task_plan_comment_thread` |  |
| `code.replaceCodeTaskPlanComment` | `PUT /v1/code/tasks/{task_id}/plan/comments/{comment_id}` | `replace_code_task_plan_comment` |  |
| `code.deleteCodeTaskPlanComment` | `DELETE /v1/code/tasks/{task_id}/plan/comments/{comment_id}` | `delete_code_task_plan_comment` |  |
| `code.resolveCodeTaskPlanCommentThread` | `POST /v1/code/tasks/{task_id}/plan/comments/threads/{thread_id}/resolve` | `resolve_code_task_plan_comment_thread` |  |
| `code.reopenCodeTaskPlanCommentThread` | `POST /v1/code/tasks/{task_id}/plan/comments/threads/{thread_id}/reopen` | `reopen_code_task_plan_comment_thread` |  |

### `verify`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `verify.updateVerifyJourney` | `PUT /v1/verify/repositories/{repository_id}/journeys/{cuj_id}` | `update_verify_journey` |  |
| `verify.listVerifyRepositories` | `GET /v1/verify/repositories` | `list_verify_repositories` | `cursor` |
| `verify.registerVerifyRepository` | `POST /v1/verify/repositories` | `register_verify_repository` |  |
| `verify.getVerifyRepository` | `GET /v1/verify/repositories/{repository_id}` | `get_verify_repository` |  |
| `verify.configureVerifyRepository` | `PUT /v1/verify/repositories/{repository_id}` | `configure_verify_repository` |  |
| `verify.listVerifyJourneys` | `GET /v1/verify/repositories/{repository_id}/journeys` | `list_verify_journeys` |  |
| `verify.createVerifyJourney` | `POST /v1/verify/repositories/{repository_id}/journeys` | `create_verify_journey` |  |
| `verify.listVerifyJobs` | `GET /v1/verify/repositories/{repository_id}/jobs` | `list_verify_jobs` | `cursor` |
| `verify.startVerifyJob` | `POST /v1/verify/repositories/{repository_id}/jobs` | `start_verify_job` |  |
| `verify.getVerifyJob` | `GET /v1/verify/repositories/{repository_id}/jobs/{job_id}` | `get_verify_job` |  |
| `verify.listVerifySchedules` | `GET /v1/verify/repositories/{repository_id}/schedules` | `list_verify_schedules` | `cursor` |
| `verify.getVerifyScheduleHistory` | `GET /v1/verify/repositories/{repository_id}/schedules/{schedule_id}/history` | `get_verify_schedule_history` | `cursor` |
| `verify.changeVerifySchedule` | `POST /v1/verify/repositories/{repository_id}/schedules/changes` | `change_verify_schedule` |  |
| `verify.getVerifyJobBugs` | `GET /v1/verify/repositories/{repository_id}/jobs/{job_id}/bugs` | `get_verify_job_bugs` |  |
| `verify.getVerifyBugHistory` | `GET /v1/verify/repositories/{repository_id}/bugs/{bug_id}/history` | `get_verify_bug_history` | `page` from 0 |
| `verify.getVerifyExecution` | `GET /v1/verify/repositories/{repository_id}/executions/{execution_id}` | `get_verify_execution` |  |
| `verify.getVerifyEvidence` | `GET /v1/verify/repositories/{repository_id}/executions/{execution_id}/evidence/{artifact_id}` | `get_verify_evidence` |  |
| `verify.listVerifyFindings` | `GET /v1/verify/repositories/{repository_id}/findings` | `list_verify_findings` | `cursor` |
| `verify.downloadVerifyEvidence` | `GET /v1/verify/repositories/{repository_id}/executions/{execution_id}/evidence/{artifact_id}/content` | `download_verify_evidence` |  |

### `codeEnvironments`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `codeEnvironments.listCodeEnvironmentAssignments` | `GET /v1/code/environment-assignments` | `list_code_environment_assignments` |  |
| `codeEnvironments.listCodeEnvironments` | `GET /v1/code/environments` | `list_code_environments` |  |
| `codeEnvironments.createCodeEnvironment` | `POST /v1/code/environments` | `create_code_environment` |  |
| `codeEnvironments.getCodeEnvironment` | `GET /v1/code/environments/{environmentId}` | `get_code_environment` |  |
| `codeEnvironments.updateCodeEnvironment` | `PUT /v1/code/environments/{environmentId}` | `update_code_environment` |  |
| `codeEnvironments.archiveCodeEnvironment` | `DELETE /v1/code/environments/{environmentId}` | `archive_code_environment` |  |
| `codeEnvironments.addCodeEnvironmentRepository` | `POST /v1/code/environments/{environmentId}/repositories` | `add_code_environment_repository` |  |
| `codeEnvironments.updateCodeEnvironmentRepository` | `PUT /v1/code/environments/{environmentId}/repositories/{repositoryAssignmentId}` | `update_code_environment_repository` |  |
| `codeEnvironments.removeCodeEnvironmentRepository` | `DELETE /v1/code/environments/{environmentId}/repositories/{repositoryAssignmentId}` | `remove_code_environment_repository` |  |
| `codeEnvironments.setCodeEnvironmentVariable` | `PUT /v1/code/environments/{environmentId}/variables` | `set_code_environment_variable` |  |
| `codeEnvironments.deleteCodeEnvironmentVariable` | `DELETE /v1/code/environments/{environmentId}/variables/{variableId}` | `delete_code_environment_variable` |  |

### `administration`

| Method | HTTP | operationId | Pages |
| - | - | - | - |
| `administration.listRoles` | `GET /v1/configuration/roles` | `list_roles` |  |
| `administration.createRole` | `POST /v1/configuration/roles` | `create_role` |  |
| `administration.getRole` | `GET /v1/configuration/roles/{roleId}` | `get_role` |  |
| `administration.deleteRole` | `DELETE /v1/configuration/roles/{roleId}` | `delete_role` |  |
| `administration.updateRole` | `PATCH /v1/configuration/roles/{roleId}` | `update_role` |  |
| `administration.listRolePermissionOptions` | `GET /v1/configuration/roles/permissions` | `list_role_permission_options` |  |

<!-- methods:end -->

## Development

```sh
npm install
npm run check      # typecheck, tests, build, then load dist through ESM and CJS
```

| Script | What it does |
| - | - |
| `npm run generate` | Regenerate `src/generated/` from the spec (skipped when nothing changed) |
| `npm run typecheck` | `tsc --strict` over the source and tests, including compile-time type assertions in `test/types.check.ts` |
| `npm test` | All tests with `node:test`, no network |
| `npm run build` | ESM to `dist/esm`, CommonJS to `dist/cjs` |
| `npm run test:dist` | Load both builds and type-check a small consumer against each |
| `npm run update-spec` | Download the current spec into `spec/openapi.json.gz` |

The tests never call the real API. They read the spec directly and check that:

- the client has exactly one method per spec operation,
- every request has the spec's method and path, sends required parameters, sends no undeclared ones, serializes arrays and deep objects in the declared style, sends the body when required, and puts the organization selector where that operation's schema expects it,
- a missing required input fails before any request is made,
- every documented 2xx response, built from the spec's examples and schemas, comes back parsed with the right type,
- every documented error response becomes the right error class with its code and message,
- each pagination helper uses a request parameter and response fields that exist in the spec,
- retries, `Retry-After`, timeouts, cancellation and the pagination stop rules behave as described above.

## License

MIT, see [LICENSE](LICENSE).
