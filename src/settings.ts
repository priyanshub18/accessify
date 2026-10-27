import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_FILE = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '.env');

/** Values set from the dashboard win over the environment. Keys never leave the server. */
const over: { geminiKey?: string; githubToken?: string; model?: string } = {};
let autoModel: string | undefined;

export const geminiKey = () => over.geminiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
export const githubToken = () => over.githubToken ?? process.env.GITHUB_TOKEN;
export const geminiModel = () => over.model ?? process.env.ACCESSIFY_MODEL ?? autoModel ?? 'gemini-2.5-flash';
export const geminiBase = () => process.env.GEMINI_BASE ?? 'https://generativelanguage.googleapis.com/v1beta';

export function loadEnvFile() {
  try { if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE); } catch { /* malformed .env is ignored */ }
}

/** Remember a value for this process and in the gitignored .env so it survives a restart. */
export function remember(name: 'GEMINI_API_KEY' | 'GITHUB_TOKEN', value: string) {
  if (name === 'GEMINI_API_KEY') over.geminiKey = value; else over.githubToken = value;
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l && !l.startsWith(name + '=')) : [];
  lines.push(`${name}=${value}`);
  writeFileSync(ENV_FILE, lines.join('\n') + '\n');
  try { chmodSync(ENV_FILE, 0o600); } catch { /* best effort */ }
}

export function setAutoModel(m: string) { autoModel = m; }
