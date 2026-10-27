import { execFile } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { TEMPLATE_EXT } from './templates.ts';
import { createServer, type Server } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run('git', ['-c', 'user.name=Accessify', '-c', 'user.email=accessify@users.noreply.github.com', ...args], { cwd, maxBuffer: 32 * 1024 * 1024 });

export interface Workspace { dir: string; baseSha: string; origin: string | null; repoSlug: string | null }

/** Turn an existing folder of files into a git workspace with a baseline commit. */
export async function initBaseline(dir: string, msg = 'baseline: before Accessify'): Promise<Workspace> {
  await git(dir, 'init', '-q');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', msg);
  const baseSha = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
  return { dir, baseSha, origin: null, repoSlug: null };
}

export async function prepareWorkspace(target: string, dest: string): Promise<Workspace> {
  let slug: string | null = null;
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(target)) {
    slug = target.replace(/^https:\/\/github\.com\//, '').replace(/(\.git)?\/?$/, '');
    await run('git', ['clone', '--depth', '1', `https://github.com/${slug}.git`, dest]);
  } else {
    const src = resolve(target.replace(/^~/, process.env.HOME ?? '~'));
    if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(`Not a folder or GitHub URL: ${target}`);
    cpSync(src, dest, { recursive: true, filter: (p) => !/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(relative(src, p)) });
    await git(dest, 'init', '-q');
    await git(dest, 'add', '-A');
    await git(dest, 'commit', '-q', '-m', 'baseline: site before Accessify');
  }
  const baseSha = (await git(dest, 'rev-parse', 'HEAD')).stdout.trim();
  const origin = slug ? `https://github.com/${slug}` : null;
  return { dir: dest, baseSha, origin, repoSlug: slug };
}

export function discoverPages(dir: string, limit = 12): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (['node_modules', '.git', 'dist', 'build', '.next'].includes(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.html?$/i.test(name)) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  out.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.split('/').length - b.split('/').length || a.localeCompare(b)));
  return out.slice(0, limit);
}

/** JSX/TSX/Vue/Svelte/Astro/PHP/… files that contain markup worth scanning statically. */
export function discoverTemplates(dir: string, limit = 40): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'out', 'coverage', 'vendor', '.output']);
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (skip.has(name) || name.startsWith('.')) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (TEMPLATE_EXT.test(name) && !/\.(test|spec|stories)\./.test(name) && st.size < 400_000 && /<[A-Za-z]/.test(readFileSync(p, 'utf8'))) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.slice(0, limit);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

export function serveDir(dir: string, bindHost = '127.0.0.1'): Promise<{ origin: string; server: Server }> {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const u = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let p = resolve(join(root, u));
    if (p !== root && !p.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(p).pipe(res);
  });
  return new Promise((ok) => server.listen(0, bindHost, () => ok({ origin: `http://${bindHost}:${(server.address() as any).port}`, server })));
}

/** Put every tracked file back to the baseline so fixes can be re-applied from scratch. */
export async function resetTree(ws: Workspace) {
  await git(ws.dir, 'checkout', '-q', ws.baseSha, '--', '.');
}

export async function restoreFile(ws: Workspace, file: string) {
  await git(ws.dir, 'checkout', '-q', ws.baseSha, '--', file);
}

/** Unified diff of the working tree against the baseline, without committing anything. */
export async function previewDiff(ws: Workspace): Promise<string> {
  await git(ws.dir, 'add', '-A');
  return (await git(ws.dir, 'diff', '--cached', ws.baseSha, '--unified=2')).stdout;
}

const safeBranch = (b: string) => b.trim().replace(/[^\w./-]+/g, '-').replace(/^[-./]+|[-./]+$|\.\.|\.lock$/g, '') || 'accessify/a11y-fixes';

/** One clean commit on top of the baseline, however many times the reviewer re-applied edits. */
export async function commitFixes(ws: Workspace, message: string, branchName = 'accessify/a11y-fixes'): Promise<{ branch: string; patch: string; changed: boolean }> {
  const branch = safeBranch(branchName);
  await git(ws.dir, 'checkout', '-q', '-B', branch);
  await git(ws.dir, 'reset', '-q', '--soft', ws.baseSha);
  await git(ws.dir, 'add', '-A');
  const status = (await git(ws.dir, 'status', '--porcelain')).stdout.trim();
  if (!status) return { branch, patch: '', changed: false };
  await git(ws.dir, 'commit', '-q', '-m', message);
  const patch = (await git(ws.dir, 'diff', ws.baseSha, 'HEAD', '--unified=2')).stdout;
  return { branch, patch, changed: true };
}

const parseSlug = (s: string) => s.trim().replace(/^https?:\/\/github\.com\//, '').replace(/(\.git)?\/?$/, '');

/**
 * Push the commit and open a PR. Pushes to the repo if the token can write there, otherwise to the
 * token owner's fork. For a local-folder target, the reviewed patch is applied to a fresh clone of `repo`.
 */
export async function openPullRequest(
  ws: Workspace, o: { branch: string; title: string; body: string; patch: string; token: string; repo?: string; runDir: string },
): Promise<{ url: string; repo: string; fork: boolean; reused: boolean }> {
  const { token, branch } = o;
  const hide = (s: string) => s.replaceAll(token, '***');
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'accessify' };
  const gh = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`https://api.github.com${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
    const j: any = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  };

  const slug = ws.repoSlug ?? (o.repo ? parseSlug(o.repo) : null);
  if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error('Enter the GitHub repository to raise the PR against (owner/repo or its URL). This run started from a local folder.');

  const me = await gh('/user');
  if (!me.ok) throw new Error(me.status === 401 ? 'GitHub rejected the token (401). Check it in Settings.' : `GitHub API ${me.status} while checking the token`);
  const repo = await gh(`/repos/${slug}`);
  if (!repo.ok) throw new Error(repo.status === 404 ? `Cannot see ${slug}. Check the name, and that the token can access it.` : `GitHub API ${repo.status}: ${repo.j.message}`);

  // Where the commit lives: the target clone, or a fresh clone with the patch applied for local folders.
  let dir = ws.dir;
  if (!ws.repoSlug) {
    dir = join(o.runDir, 'pr-clone');
    rmSync(dir, { recursive: true, force: true });
    await run('git', ['clone', '--depth', '1', `https://x-access-token:${token}@github.com/${slug}.git`, dir]).catch((e) => { throw new Error(hide(`clone failed: ${String(e.stderr ?? e.message).slice(0, 200)}`)); });
    const patchFile = join(o.runDir, 'review.patch');
    writeFileSync(patchFile, o.patch);
    try { await git(dir, 'apply', '--whitespace=nowarn', patchFile); }
    catch (e: any) { throw new Error(`The patch does not apply to ${slug}'s default branch (${String(e.stderr ?? '').split('\n')[0]}). The folder you scanned must match the repo root.`); }
    await git(dir, 'checkout', '-q', '-B', branch);
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', o.title);
  }

  let headRepo = slug, head = branch, fork = false;
  if (!repo.j.permissions?.push) {
    fork = true;
    const f = await gh(`/repos/${slug}/forks`, { method: 'POST', body: '{}' });
    if (!f.ok) throw new Error(`Could not fork ${slug}: ${f.j.message ?? f.status}`);
    headRepo = f.j.full_name; head = `${me.j.login}:${branch}`;
    for (let n = 0; n < 20; n++) { if ((await gh(`/repos/${headRepo}`)).ok) break; await new Promise((r) => setTimeout(r, 1500)); }
  }
  try {
    await run('git', ['push', '--force', `https://x-access-token:${token}@github.com/${headRepo}.git`, `${branch}:${branch}`], { cwd: dir });
  } catch (e: any) {
    throw new Error(hide(`git push to ${headRepo} failed: ${String(e.stderr ?? e.message).slice(0, 300)}`));
  }

  const made = await gh(`/repos/${slug}/pulls`, { method: 'POST', body: JSON.stringify({ title: o.title, head, base: repo.j.default_branch ?? 'main', body: o.body, maintainer_can_modify: true }) });
  if (made.ok) return { url: made.j.html_url, repo: slug, fork, reused: false };
  if (made.status === 422 && /already exists/i.test(JSON.stringify(made.j))) {
    const open = await gh(`/repos/${slug}/pulls?head=${encodeURIComponent(head.includes(':') ? head : `${slug.split('/')[0]}:${head}`)}&state=open`);
    const pr = open.j?.[0];
    if (pr) {
      await gh(`/repos/${slug}/pulls/${pr.number}`, { method: 'PATCH', body: JSON.stringify({ title: o.title, body: o.body }) });
      return { url: pr.html_url, repo: slug, fork, reused: true };
    }
  }
  throw new Error(`GitHub API ${made.status}: ${made.j.message ?? 'unknown error'}${made.j.errors?.[0]?.message ? ` (${made.j.errors[0].message})` : ''}`);
}
