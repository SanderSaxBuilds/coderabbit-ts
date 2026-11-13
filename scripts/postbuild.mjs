// Post-build fixes:
// 1. Marks dist/cjs as CommonJS so Node loads it with require() despite "type": "module" at the root.
// 2. tsc rewrites relative ".ts" specifiers to ".js" in emitted JavaScript but not in declaration
//    files, so the same rewrite is applied to every .d.ts here.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './spec.mjs';

const dist = path.join(ROOT, 'dist');
writeFileSync(path.join(dist, 'cjs', 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`, 'utf8');

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (name.endsWith('.d.ts')) {
      const text = readFileSync(file, 'utf8');
      const next = text.replace(/(from\s+|import\(\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2');
      if (next !== text) writeFileSync(file, next, 'utf8');
    }
  }
}
walk(dist);
