import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAccessify } from './agent.ts';

const here = dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2] ?? 'demo';
const target = arg === 'demo' ? join(here, '..', 'demo-site') : arg;
const runDir = resolve(here, '..', 'runs', `cli-${Date.now()}`);
mkdirSync(runDir, { recursive: true });

const session = await runAccessify({ target, runDir }, (type, data = {}) => {
  if (type === 'log') console.log(`  ${data.level === 'warn' ? '!' : data.level === 'ok' ? '✓' : '·'} ${data.msg}`);
  else if (type === 'phase') console.log(`\n== ${data.label}`);
  else if (type === 'score') console.log(`   score ${data.label}: ${data.score}`);
  else if (type === 'review') console.log(`\nDONE`, data);
});
await session.close();
console.log('run dir:', runDir);
