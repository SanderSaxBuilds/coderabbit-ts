// Generates src/generated/* from spec/openapi.json.gz.
//
//   schema.ts      component and operation types, produced by openapi-typescript
//   operations.ts  runtime operation table plus input and output types per operation
//   resources.ts   namespaced methods, one per operation
//
// It also rewrites the method table in README.md between the
// <!-- methods:start --> and <!-- methods:end --> markers.
//
// The generator refuses to run when the spec contains something it does not
// understand (an unknown tag, a duplicate method name, a parameter clash), so a
// spec update cannot silently drop an operation.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { ROOT, loadSpec, specSha256 } from './spec.mjs';

const OUT_DIR = path.join(ROOT, 'src', 'generated');
const STAMP = path.join(OUT_DIR, '.stamp');
const AUTH_HEADER = 'x-coderabbitai-api-key';
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

export const TAG_NAMESPACE = {
  Identity: 'identity',
  Organizations: 'organizations',
  Repositories: 'repositories',
  'Pull requests': 'pullRequests',
  Reviews: 'reviews',
  Coding: 'code',
  'Coding environments': 'codeEnvironments',
  Triage: 'triage',
  'Triage rules': 'triageRules',
  Security: 'security',
  'Bug Scan': 'bugScan',
  Verify: 'verify',
  Automations: 'automations',
  Configuration: 'configuration',
  Connections: 'connections',
  'Architecture knowledge': 'architecture',
  Knowledge: 'knowledge',
  Learnings: 'learnings',
  Usage: 'usage',
  Reports: 'reports',
  Metrics: 'metrics',
  Administration: 'administration',
  'User Management': 'users',
  'Audit Logs': 'auditLogs',
  // Tag names used by the spec since November 2026. Operations that existed
  // before keep their namespace through scripts/namespaces.json, so these only
  // place new operations.
  'Coding Agent': 'code',
  'Knowledge Base': 'knowledge',
  'Organizations and repositories': 'organizations',
  'Pull requests and reviews': 'pullRequests',
  'Usage and metrics': 'usage',
  'Users and roles': 'users',
};

// Namespace of every operation in the first published client. The spec later
// regrouped its tags, and keeping these stops client.<namespace>.<method>
// calls from moving between releases.
export const OPERATION_NAMESPACE = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'namespaces.json'), 'utf8'),
);

// Operations that once carried no tag in the spec. They are placed next to the
// operations the docs group them with. The current spec tags everything.
export const UNTAGGED_NAMESPACE = {
  'report-generate': 'reports',
  'review-metrics': 'metrics',
  'change-roles': 'users',
};

const ITEM_KEYS = ['data', 'items', 'users', 'organizations', 'repositories', 'attempts', 'requests', 'observations'];
const CURSOR_PAIRS = [
  ['cursor', 'next_cursor'],
  ['cursor', 'nextCursor'],
  ['page_token', 'next_page_token'],
  ['before_turn_start_seq', 'next_before_turn_start_seq'],
  ['offset', 'next_offset'],
];

function fail(message) {
  console.error(`generate: ${message}`);
  process.exit(1);
}

function camel(id) {
  const parts = id.split(/[-_.]+/).filter(Boolean);
  return parts.map((p, i) => (i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase())).join('');
}

function makeResolver(spec) {
  const resolve = (node) => {
    let cur = node;
    const seen = new Set();
    while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
      if (seen.has(cur.$ref)) fail(`circular $ref ${cur.$ref}`);
      seen.add(cur.$ref);
      const parts = cur.$ref.replace(/^#\//, '').split('/');
      cur = parts.reduce((acc, key) => (acc ? acc[key] : undefined), spec);
      if (cur === undefined) fail(`unresolved $ref ${[...seen].pop()}`);
    }
    return cur;
  };
  return resolve;
}

function schemaIsArray(schema, resolve) {
  const s = resolve(schema) || {};
  if (s.type === 'array') return true;
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(s[key]) && s[key].some((x) => resolve(x)?.type === 'array')) return true;
  }
  return false;
}

function objectProps(schema, resolve) {
  const s = resolve(schema);
  if (!s || typeof s !== 'object') return {};
  const props = { ...(s.properties || {}) };
  if (Array.isArray(s.allOf)) for (const part of s.allOf) Object.assign(props, objectProps(part, resolve));
  return props;
}

function firstSentence(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const m = clean.match(/^(.{1,200}?[.!?])(\s|$)/);
  return m ? m[1] : clean.slice(0, 200);
}

function docText(text) {
  return String(text).replace(/\*\//g, '*\\/').replace(/\s+/g, ' ').trim();
}

export function collectOperations(spec) {
  const resolve = makeResolver(spec);
  const ops = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const id = op.operationId;
      if (!id) fail(`${method.toUpperCase()} ${p} has no operationId`);
      const tag = op.tags?.[0];
      const namespace = OPERATION_NAMESPACE[id] ?? (tag ? TAG_NAMESPACE[tag] : UNTAGGED_NAMESPACE[id]);
      if (!namespace) fail(`no namespace for operation ${id} (tag ${tag ?? 'none'})`);

      const params = [...shared, ...(op.parameters || [])].map(resolve);
      const pathNames = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const name of pathNames) {
        if (!params.some((x) => x.in === 'path' && x.name === name)) fail(`${id}: path parameter ${name} is not declared`);
      }
      const query = params
        .filter((x) => x.in === 'query')
        .map((x) => {
          const array = schemaIsArray(x.schema, resolve);
          const explode = x.explode ?? (x.style ? x.style === 'form' : true);
          return { name: x.name, required: x.required === true, style: x.style ?? 'form', array, explode };
        });
      const headers = params
        .filter((x) => x.in === 'header' && x.name.toLowerCase() !== AUTH_HEADER)
        .map((x) => ({ name: x.name, required: x.required === true }));

      let body = null;
      let bodyProps = {};
      if (op.requestBody) {
        const rb = resolve(op.requestBody);
        const types = Object.keys(rb.content || {});
        if (!types.includes('application/json')) fail(`${id}: request body is not JSON (${types.join(', ')})`);
        body = rb.required ? 'required' : 'optional';
        bodyProps = objectProps(rb.content['application/json'].schema, resolve);
      }

      const names = [...pathNames, ...query.map((q) => q.name), ...headers.map((h) => h.name)];
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) fail(`${id}: parameter ${dup} appears in more than one location`);
      if (body && names.includes('body')) fail(`${id}: a parameter is named body`);

      const queryOrg = query.some((q) => q.name === 'org_id' || q.name === 'org_name');
      const bodyOrg = 'org_id' in bodyProps || 'org_name' in bodyProps;
      const org = queryOrg ? 'query' : bodyOrg ? 'body' : null;
      const idempotencyKey = 'client_operation_id' in bodyProps ? 'client_operation_id' : 'idempotency_key' in bodyProps ? 'idempotency_key' : null;

      const success = [];
      for (const [code, raw] of Object.entries(op.responses || {})) {
        if (!/^2\d\d$/.test(code)) continue;
        const res = resolve(raw);
        success.push({ status: Number(code), types: Object.keys(res.content || {}) });
      }
      if (success.length === 0) fail(`${id}: no 2xx response`);

      let pagination = null;
      const ok = success.find((s) => s.types.includes('application/json'));
      if (ok) {
        const res = resolve(op.responses[String(ok.status)]);
        const props = objectProps(res.content['application/json'].schema, resolve);
        const items = ITEM_KEYS.find((k) => k in props && schemaIsArray(props[k], resolve));
        if (items) {
          const qnames = query.map((q) => q.name);
          const pair = CURSOR_PAIRS.find(([param, next]) => qnames.includes(param) && next in props);
          if (pair) {
            pagination = { kind: 'cursor', param: pair[0], next: pair[1], items };
          } else if (qnames.includes('page')) {
            const pageParam = params.find((x) => x.in === 'query' && x.name === 'page');
            const ps = resolve(pageParam.schema) || {};
            let start = 1;
            if (typeof ps.default === 'number') start = ps.default;
            else if (typeof ps.minimum === 'number') start = ps.exclusiveMinimum === true ? ps.minimum + 1 : ps.minimum;
            pagination = { kind: 'page', param: 'page', start, items };
          }
        }
      }

      const deprecated = op.deprecated === true || /^DEPRECATED\b/.test(String(op.description || ''));
      const summary = docText(op.summary && op.summary.trim() ? op.summary : firstSentence(op.description));
      ops.push({
        id,
        namespace,
        name: camel(id),
        method: method.toUpperCase(),
        path: p,
        pathParams: pathNames,
        query,
        headers,
        body,
        org,
        idempotencyKey,
        success,
        pagination,
        deprecated,
        summary,
      });
    }
  }
  const seen = new Map();
  for (const op of ops) {
    const key = `${op.namespace}.${op.name}`;
    if (seen.has(key)) fail(`duplicate method ${key} (${seen.get(key)} and ${op.id})`);
    seen.set(key, op.id);
  }
  return ops;
}

const q = (s) => JSON.stringify(s);
const opRef = (id) => `operations[${q(id)}]`;

function inputType(op) {
  const parts = [];
  if (op.pathParams.length) parts.push(`${opRef(op.id)}['parameters']['path']`);
  if (op.query.length) parts.push(`NonNullable<${opRef(op.id)}['parameters']['query']>`);
  if (op.headers.length) {
    const keys = op.headers.map((h) => q(h.name)).join(' | ');
    parts.push(`Pick<NonNullable<${opRef(op.id)}['parameters']['header']>, ${keys}>`);
  }
  if (op.body) {
    const bodyType = `NonNullable<${opRef(op.id)}['requestBody']>['content']['application/json']`;
    parts.push(op.body === 'required' ? `{ body: ${bodyType} }` : `{ body?: ${bodyType} }`);
  }
  return parts.length ? parts.join(' & ') : 'NoInput';
}

function outputType(op) {
  const members = new Set();
  for (const s of op.success) {
    if (s.types.length === 0) {
      members.add('undefined');
      continue;
    }
    for (const t of s.types) {
      if (t.includes('json')) members.add(`${opRef(op.id)}['responses'][${s.status}]['content'][${q(t)}]`);
      else if (t.startsWith('text/')) members.add('string');
      else members.add('ArrayBuffer');
    }
  }
  return [...members].join(' | ');
}

function inputHasRequired(op) {
  return op.pathParams.length > 0 || op.query.some((x) => x.required) || op.headers.some((h) => h.required) || op.body === 'required';
}

function emitOperations(ops) {
  const lines = [];
  lines.push('// Generated from spec/openapi.json.gz by scripts/generate.mjs. Do not edit.');
  lines.push("import type { operations } from './schema.ts';");
  lines.push('');
  lines.push('/** Input for an operation that takes no parameters. */');
  lines.push('export type NoInput = Record<string, never>;');
  lines.push('');
  lines.push('/** Every operation in the spec, keyed by operationId. */');
  lines.push('export const OPERATIONS = {');
  for (const op of ops) {
    const table = {
      id: op.id,
      namespace: op.namespace,
      method: op.method,
      path: op.path,
      pathParams: op.pathParams,
      query: op.query,
      headers: op.headers,
      body: op.body,
      org: op.org,
      idempotencyKey: op.idempotencyKey,
      success: op.success,
      pagination: op.pagination,
    };
    lines.push(`  ${q(op.id)}: ${JSON.stringify(table)},`);
  }
  lines.push('} as const;');
  lines.push('');
  lines.push('export type OperationId = keyof typeof OPERATIONS;');
  lines.push('');
  lines.push('/** Request input per operation: path, query and header parameters by name, plus `body`. */');
  lines.push('export interface OperationInputs {');
  for (const op of ops) lines.push(`  ${q(op.id)}: ${inputType(op)};`);
  lines.push('}');
  lines.push('');
  lines.push('/** Parsed success body per operation (union of the documented 2xx responses). */');
  lines.push('export interface OperationOutputs {');
  for (const op of ops) lines.push(`  ${q(op.id)}: ${outputType(op)};`);
  lines.push('}');
  lines.push('');
  const paged = ops.filter((o) => o.pagination);
  lines.push('/** Operations the pagination helpers can walk. */');
  lines.push(`export type PaginatedOperationId = ${paged.map((o) => q(o.id)).join(' | ')};`);
  lines.push('');
  lines.push('/** Item type yielded by `client.items()` per paginated operation. */');
  lines.push('export interface PageItems {');
  for (const op of paged) {
    const ok = op.success.find((s) => s.types.includes('application/json'));
    lines.push(`  ${q(op.id)}: NonNullable<${opRef(op.id)}['responses'][${ok.status}]['content']['application/json'][${q(op.pagination.items)}]>[number];`);
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function emitResources(ops) {
  const byNs = new Map();
  for (const op of ops) {
    if (!byNs.has(op.namespace)) byNs.set(op.namespace, []);
    byNs.get(op.namespace).push(op);
  }
  const lines = [];
  lines.push('// Generated from spec/openapi.json.gz by scripts/generate.mjs. Do not edit.');
  lines.push("import type { OperationId, OperationInputs, OperationOutputs } from './operations.ts';");
  lines.push("import type { RequestOptions } from '../types.ts';");
  lines.push('');
  lines.push('export type Caller = <K extends OperationId>(id: K, input: OperationInputs[K] | undefined, options?: RequestOptions) => Promise<OperationOutputs[K]>;');
  lines.push('');
  lines.push('export function createResources(call: Caller) {');
  lines.push('  return {');
  for (const [ns, list] of byNs) {
    lines.push(`    ${ns}: {`);
    for (const op of list) {
      const opt = inputHasRequired(op) ? '' : '?';
      lines.push('      /**');
      if (op.summary) lines.push(`       * ${op.summary}`);
      lines.push(`       * \`${op.method} ${op.path}\` (operationId \`${op.id}\`)`);
      if (op.deprecated) lines.push('       * @deprecated Marked as deprecated in the spec description.');
      lines.push('       */');
      lines.push(`      ${op.name}: (input${opt}: OperationInputs[${q(op.id)}], options?: RequestOptions): Promise<OperationOutputs[${q(op.id)}]> => call(${q(op.id)}, input, options),`);
    }
    lines.push('    },');
  }
  lines.push('  };');
  lines.push('}');
  lines.push('');
  lines.push('export type Resources = ReturnType<typeof createResources>;');
  lines.push('');
  return lines.join('\n');
}

function emitReadmeTable(ops) {
  const byNs = new Map();
  for (const op of ops) {
    if (!byNs.has(op.namespace)) byNs.set(op.namespace, []);
    byNs.get(op.namespace).push(op);
  }
  const out = [];
  out.push(`${ops.length} operations, ${byNs.size} namespaces. Generated from the spec by \`npm run generate\`.`);
  out.push('');
  for (const [ns, list] of byNs) {
    out.push(`### \`${ns}\``);
    out.push('');
    out.push('| Method | HTTP | operationId | Pages |');
    out.push('| - | - | - | - |');
    for (const op of list) {
      const pages = op.pagination ? (op.pagination.kind === 'page' ? `\`page\` from ${op.pagination.start}` : `\`${op.pagination.param}\``) : '';
      const dep = op.deprecated ? ' (deprecated)' : '';
      out.push(`| \`${ns}.${op.name}\`${dep} | \`${op.method} ${op.path}\` | \`${op.id}\` | ${pages} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function main() {
  const force = process.argv.includes('--force');
  const stamp = `${specSha256()} ${hashFile(new URL(import.meta.url))}`;
  const outputs = ['schema.ts', 'operations.ts', 'resources.ts'].map((f) => path.join(OUT_DIR, f));
  if (!force && existsSync(STAMP) && outputs.every(existsSync) && readFileSync(STAMP, 'utf8') === stamp) {
    console.log('generate: up to date');
    return;
  }
  const spec = loadSpec();
  const ops = collectOperations(spec);
  mkdirSync(OUT_DIR, { recursive: true });

  const ast = await openapiTS(spec, { silent: true });
  const schema = `// Generated from spec/openapi.json.gz by openapi-typescript. Do not edit.\n${astToString(ast)}`;
  writeFileSync(path.join(OUT_DIR, 'schema.ts'), schema, 'utf8');
  writeFileSync(path.join(OUT_DIR, 'operations.ts'), emitOperations(ops), 'utf8');
  writeFileSync(path.join(OUT_DIR, 'resources.ts'), emitResources(ops), 'utf8');

  const readmePath = path.join(ROOT, 'README.md');
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8');
    const start = '<!-- methods:start -->';
    const end = '<!-- methods:end -->';
    const a = readme.indexOf(start);
    const b = readme.indexOf(end);
    if (a !== -1 && b > a) {
      const next = `${readme.slice(0, a + start.length)}\n${emitReadmeTable(ops)}\n${readme.slice(b)}`;
      if (next !== readme) writeFileSync(readmePath, next, 'utf8');
    }
  }
  writeFileSync(STAMP, stamp, 'utf8');
  const paged = ops.filter((o) => o.pagination).length;
  console.log(`generate: ${ops.length} operations, ${paged} with pagination, ${new Set(ops.map((o) => o.namespace)).size} namespaces`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
