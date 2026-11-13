// Shared helpers for reading the pinned OpenAPI spec.
// The spec is stored gzip-compressed (spec/openapi.json.gz), byte-for-byte as
// published at https://docs.coderabbit.ai/openapi.json.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SPEC_GZ = path.join(ROOT, 'spec', 'openapi.json.gz');
export const SPEC_URL = 'https://docs.coderabbit.ai/openapi.json';

export function readSpecBytes() {
  return gunzipSync(readFileSync(SPEC_GZ));
}

export function loadSpec() {
  let text = readSpecBytes().toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

export function specSha256() {
  return createHash('sha256').update(readSpecBytes()).digest('hex');
}
