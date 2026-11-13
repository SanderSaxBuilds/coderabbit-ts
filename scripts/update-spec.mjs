// Downloads the current published spec and stores it as spec/openapi.json.gz.
// Usage: node scripts/update-spec.mjs [path-to-local-openapi.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { SPEC_GZ, SPEC_URL } from './spec.mjs';

const local = process.argv[2];
let bytes;
if (local) {
  bytes = readFileSync(local);
} else {
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`GET ${SPEC_URL} failed with ${res.status}`);
  bytes = Buffer.from(await res.arrayBuffer());
}
JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
writeFileSync(SPEC_GZ, gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION }));
const sha = createHash('sha256').update(bytes).digest('hex');
console.log(`spec/openapi.json.gz written, ${bytes.length} bytes uncompressed, sha256 ${sha}`);
console.log('Run "npm run generate" to refresh the generated types.');
