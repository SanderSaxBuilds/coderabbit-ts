// Removes dist/ before a build.
import { rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './spec.mjs';

rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
