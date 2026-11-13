// Compiled against dist/cjs as a CommonJS consumer.
import { CodeRabbit } from '../dist/cjs/index.js';

const client = new CodeRabbit({ apiKey: 'k' });

export async function run(): Promise<number> {
  const users = await client.users.listUsers({ limit: 5 });
  return users.users.length;
}
