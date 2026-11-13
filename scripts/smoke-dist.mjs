// Loads the built package through both entry points and makes one mocked call with each.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const cjs = require('../dist/cjs/index.js');
const esm = await import('../dist/esm/index.js');

for (const [label, mod] of [['cjs', cjs], ['esm', esm]]) {
  let seen;
  const client = new mod.CodeRabbit({
    apiKey: 'test-key',
    fetch: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ principal: { type: 'api_key' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const me = await client.identity.getMe();
  assert.equal(seen.url, 'https://api.coderabbit.ai/v1/me');
  assert.equal(seen.init.headers['x-coderabbitai-api-key'], 'test-key');
  assert.equal(me.principal.type, 'api_key');
  assert.equal(Object.keys(mod.OPERATIONS).length, 175);
  console.log(`${label}: ok`);
}
