// Checks every request the client can make against the spec itself (read from
// spec/openapi.json.gz here, not from the generated table): HTTP method, path,
// required parameters, parameter serialization, body and organization selector.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { camel, isArraySchema, json, mockClient, resolve, sample, specOperations } from './helpers.ts';
import type { SpecOperation, SpecParam } from './helpers.ts';
import { CodeRabbit, OPERATIONS } from '../src/index.ts';

const ops = specOperations();
const AUTH = 'x-coderabbitai-api-key';

type Method = (input?: Record<string, unknown>) => Promise<unknown>;

function namespaces(client: CodeRabbit): Map<string, Record<string, Method>> {
  const out = new Map<string, Record<string, Method>>();
  for (const [key, value] of Object.entries(client)) {
    if (value && typeof value === 'object' && Object.values(value).length > 0 && Object.values(value).every((v) => typeof v === 'function')) {
      out.set(key, value as Record<string, Method>);
    }
  }
  return out;
}

function findMethod(client: CodeRabbit, id: string): Method[] {
  const found: Method[] = [];
  for (const ns of namespaces(client).values()) if (typeof ns[camel(id)] === 'function') found.push(ns[camel(id)]!);
  return found;
}

function paramValue(p: SpecParam): unknown {
  if (p.example !== undefined) return p.example;
  return sample(p.schema, { hint: p.name });
}

function arrayValues(p: SpecParam): string[] {
  const s = resolve(p.schema);
  const arr = s.type === 'array' ? s : [...(s.anyOf ?? []), ...(s.oneOf ?? [])].map(resolve).find((x: any) => x?.type === 'array');
  const items = resolve(arr.items) ?? {};
  if (Array.isArray(items.enum) && items.enum.length >= 2) return [String(items.enum[0]), String(items.enum[1])];
  const one = String(sample(items, { hint: p.name }));
  return [one, `${one}-b`];
}

function explodes(p: SpecParam): boolean {
  return p.explode ?? (p.style ? p.style === 'form' : true);
}

function pathMatcher(template: string): RegExp {
  const escaped = template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '([^/]+)');
  return new RegExp(`^${escaped}$`);
}

function bodySchema(op: SpecOperation) {
  return op.requestBody?.content?.['application/json']?.schema;
}

function bodyProps(op: SpecOperation): Record<string, unknown> {
  const s = resolve(bodySchema(op));
  if (!s) return {};
  const props: Record<string, unknown> = { ...(s.properties ?? {}) };
  for (const part of s.allOf ?? []) Object.assign(props, resolve(part)?.properties ?? {});
  return props;
}

function requiredInput(op: SpecOperation): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const p of op.params) {
    if (p.in === 'header' && p.name.toLowerCase() === AUTH) continue;
    if (p.in === 'path' || p.required) input[p.name] = paramValue(p);
  }
  if (op.requestBody?.required) input.body = sample(bodySchema(op));
  return input;
}

describe('spec coverage', () => {
  it(`the client exposes exactly one method per spec operation (${ops.length})`, () => {
    const client = new CodeRabbit({ apiKey: 'k', fetch: async () => json({}) });
    let total = 0;
    for (const ns of namespaces(client).values()) total += Object.keys(ns).length;
    assert.equal(total, ops.length);
    assert.equal(Object.keys(OPERATIONS).length, ops.length);
    for (const op of ops) assert.equal(findMethod(client, op.id).length, 1, `${op.id} should map to one method`);
  });

  it('every operation id in the spec is unique', () => {
    assert.equal(new Set(ops.map((o) => o.id)).size, ops.length);
  });
});

describe('requests match the spec', () => {
  for (const op of ops) {
    it(`${op.id}: ${op.method} ${op.path}`, async () => {
      // 1. Required parameters only, called through the namespaced method.
      const { client, calls } = mockClient(() => json({}), { maxRetries: 0 });
      const [method] = findMethod(client, op.id);
      assert.ok(method, `no method for ${op.id}`);
      const input = requiredInput(op);
      await method(input);
      assert.equal(calls.length, 1);
      const req = calls[0]!;
      assert.equal(req.method, op.method);
      assert.equal(req.url.origin, 'https://api.coderabbit.ai');
      const match = req.url.pathname.match(pathMatcher(op.path));
      assert.ok(match, `${req.url.pathname} does not match ${op.path}`);
      const pathNames = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
      pathNames.forEach((name, i) => assert.equal(decodeURIComponent(match[i + 1]!), String(input[name])));
      const declaredQuery = new Set(op.params.filter((p) => p.in === 'query').map((p) => p.name));
      for (const key of req.url.searchParams.keys()) assert.ok(declaredQuery.has(key.replace(/\[.*$/, '')), `undeclared query parameter ${key}`);
      for (const p of op.params.filter((x) => x.in === 'query' && x.required)) {
        const present = [...req.url.searchParams.keys()].some((k) => k === p.name || k.startsWith(`${p.name}[`));
        assert.ok(present, `missing ${p.name}`);
      }
      assert.equal(req.headers[AUTH], 'test-key');
      for (const p of op.params.filter((x) => x.in === 'header' && x.required && x.name.toLowerCase() !== AUTH)) {
        assert.ok(req.headers[p.name.toLowerCase()] !== undefined, `missing header ${p.name}`);
      }
      if (op.requestBody?.required) {
        assert.equal(req.headers['content-type'], 'application/json');
        assert.deepEqual(JSON.parse(req.body!), input.body);
      } else {
        assert.equal(req.body, undefined);
      }

      // 2. Every declared query and header parameter, called by operationId.
      const all: Record<string, unknown> = { ...input };
      for (const p of op.params) {
        if (p.in === 'path' || (p.in === 'header' && p.name.toLowerCase() === AUTH)) continue;
        if (p.name === 'org_id') continue;
        all[p.name] = isArraySchema(p.schema) ? arrayValues(p) : paramValue(p);
      }
      await (client.call as (id: string, input: unknown) => Promise<unknown>)(op.id, all);
      const full = calls[1]!;
      for (const p of op.params.filter((x) => x.in === 'query' && x.name !== 'org_id')) {
        const value = all[p.name];
        if (p.style === 'deepObject') {
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) assert.equal(full.url.searchParams.get(`${p.name}[${k}]`), String(v), `${p.name}[${k}]`);
        } else if (Array.isArray(value)) {
          if (explodes(p)) assert.deepEqual(full.url.searchParams.getAll(p.name), value, `${p.name} should repeat`);
          else assert.equal(full.url.searchParams.get(p.name), value.join(','), `${p.name} should be comma-joined`);
        } else {
          assert.equal(full.url.searchParams.get(p.name), String(value), `${p.name}`);
        }
      }
      for (const p of op.params.filter((x) => x.in === 'header' && x.name.toLowerCase() !== AUTH)) {
        assert.equal(full.headers[p.name.toLowerCase()], String(all[p.name]));
      }

      // 3. A missing required input fails before any request is sent.
      const required = Object.keys(input);
      for (const key of required) {
        const partial = { ...input };
        delete partial[key];
        const before: number = calls.length;
        await assert.rejects(method(partial), TypeError, `${op.id} without ${key}`);
        assert.equal(calls.length, before);
      }

      // 4. A default organization selector goes where this operation's schema puts it.
      const { client: orgClient, calls: orgCalls } = mockClient(() => json({}), { maxRetries: 0, org: { org_name: 'acme-org' } });
      await findMethod(orgClient, op.id)[0]!(requiredInput(op));
      const sent = orgCalls[0]!;
      const queryHasOrg = declaredQuery.has('org_name') || declaredQuery.has('org_id');
      const bodyHasOrg = 'org_name' in bodyProps(op) || 'org_id' in bodyProps(op);
      const sentBody = sent.body ? JSON.parse(sent.body) : undefined;
      if (queryHasOrg) {
        assert.equal(sent.url.searchParams.get('org_name'), 'acme-org');
        assert.ok(!sentBody || sentBody.org_name === undefined);
      } else if (bodyHasOrg) {
        assert.equal(sentBody.org_name, 'acme-org');
        assert.equal(sent.url.searchParams.get('org_name'), null);
      } else {
        assert.equal(sent.url.searchParams.get('org_name'), null);
        assert.ok(!sentBody || sentBody.org_name === undefined);
      }
    });
  }
});

describe('pagination descriptors match the spec', () => {
  for (const [id, op] of Object.entries(OPERATIONS)) {
    const p = op.pagination;
    if (!p) continue;
    it(`${id}: ${p.kind} via ${p.param}`, () => {
      const spec = ops.find((o) => o.id === id)!;
      assert.ok(spec.params.some((x) => x.in === 'query' && x.name === p.param), `query parameter ${p.param}`);
      const okCode = Object.keys(spec.responses).find((c) => /^2/.test(c) && spec.responses[c]!.content?.['application/json'])!;
      const schema = resolve(spec.responses[okCode]!.content['application/json'].schema);
      assert.ok(isArraySchema(schema.properties[p.items]), `${p.items} is an array`);
      if (p.kind === 'cursor') assert.ok(p.next in schema.properties, `${p.next} is in the response`);
      else {
        const pageSchema = resolve(spec.params.find((x) => x.name === 'page')!.schema);
        const min = typeof pageSchema.minimum === 'number' ? pageSchema.minimum + (pageSchema.exclusiveMinimum === true ? 1 : 0) : 1;
        assert.equal(p.start, pageSchema.default ?? min);
      }
    });
  }
});
