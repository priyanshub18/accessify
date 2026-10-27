import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAccessify, type Session } from './agent.ts';
import { llmInfo, verifyGemini } from './llm.ts';
import { siteTarget } from './site.ts';
import { geminiKey, githubToken, loadEnvFile, remember } from './settings.ts';

loadEnvFile();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(root, 'public');
const RUNS = join(root, 'runs');
const PORT = Number(process.env.PORT ?? 8787);
mkdirSync(RUNS, { recursive: true });

interface Run { id: string; events: any[]; subs: Set<ServerResponse>; done: boolean; dir: string; session?: Session; idle?: NodeJS.Timeout; beat?: NodeJS.Timeout }
const IDLE_MS = 30 * 60_000;
const runs = new Map<string, Run>();

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.patch': 'text/plain', '.md': 'text/plain; charset=utf-8' };

function startRun(target: string, pace: number): Run {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const run: Run = { id, events: [], subs: new Set(), done: false, dir: join(RUNS, id) };
  runs.set(id, run);
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    const ev = { n: run.events.length, t: Date.now(), type, ...data };
    run.events.push(ev);
    for (const res of run.subs) res.write(`id: ${ev.n}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  const finish = () => { run.done = true; clearInterval(run.beat); clearTimeout(run.idle); for (const res of run.subs) res.end(); run.subs.clear(); };
  run.beat = setInterval(() => { for (const res of run.subs) res.write(': ping\n\n'); }, 20_000);
  runAccessify({ target, pace, runDir: run.dir }, emit)
    .then((session) => { run.session = session; touch(run); })
    .catch((e) => { emit('error', { message: e?.message ?? String(e) }); finish(); });
  return run;
}

/** The browser and workspace stay open for review; free them after a quiet half hour. */
function touch(run: Run) {
  clearTimeout(run.idle);
  run.idle = setTimeout(async () => {
    run.events.push({ n: run.events.length, t: Date.now(), type: 'expired' });
    for (const res of run.subs) res.write(`data: ${JSON.stringify(run.events.at(-1))}\n\n`);
    await run.session?.close(); run.session = undefined; run.done = true;
  }, IDLE_MS);
}

async function githubUser(token: string): Promise<{ ok: boolean; login?: string; error?: string }> {
  try {
    const r = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${token}`, 'user-agent': 'accessify' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { ok: false, error: r.status === 401 ? 'GitHub rejected this token.' : `GitHub API ${r.status}` };
    return { ok: true, login: ((await r.json()) as any).login };
  } catch (e: any) { return { ok: false, error: e.message }; }
}
let ghLogin: string | undefined;
if (githubToken()) githubUser(githubToken()!).then((r) => { ghLogin = r.login; });
if (geminiKey()) verifyGemini(geminiKey()!);

const config = () => ({ gemini: { on: !!geminiKey(), model: llmInfo().model }, github: { on: !!githubToken(), login: ghLogin } });

const send = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;

    if (p === '/api/config') return send(res, 200, config());

    if (p === '/api/settings' && req.method === 'POST') {
      const b = await body(req);
      const out: Record<string, string> = {};
      if (typeof b.geminiKey === 'string' && b.geminiKey.trim()) {
        const v = await verifyGemini(b.geminiKey.trim());
        if (!v.ok) return send(res, 400, { error: v.error, field: 'gemini' });
        remember('GEMINI_API_KEY', b.geminiKey.trim()); out.gemini = v.model ?? 'ok';
      }
      if (typeof b.githubToken === 'string' && b.githubToken.trim()) {
        const v = await githubUser(b.githubToken.trim());
        if (!v.ok) return send(res, 400, { error: v.error, field: 'github' });
        remember('GITHUB_TOKEN', b.githubToken.trim()); ghLogin = v.login; out.github = v.login!;
      }
      return send(res, 200, { ...config(), saved: out });
    }

    if (p === '/api/run' && req.method === 'POST') {
      const b = await body(req);
      const raw = String(b.target ?? '').trim();
      const target = b.demo ? join(root, 'demo-site') : siteTarget(raw) ?? raw;
      if (!target) return send(res, 400, { error: 'Give a website URL, a GitHub repo, or a folder path, or use the demo site.' });
      return send(res, 200, { id: startRun(target, 120).id });
    }

    let m = p.match(/^\/api\/run\/([\w-]+)\/events$/);
    if (m) {
      const run = runs.get(m[1]);
      if (!run) return send(res, 404, { error: 'no such run' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const last = Number(req.headers['last-event-id'] ?? -1);
      for (const ev of run.events) if (ev.n > last) res.write(`id: ${ev.n}\ndata: ${JSON.stringify(ev)}\n\n`);
      if (run.done) return void res.end();
      run.subs.add(res);
      req.on('close', () => run.subs.delete(res));
      return;
    }

    m = p.match(/^\/api\/run\/([\w-]+)\/(review|pr)$/);
    if (m && req.method === 'POST') {
      const run = runs.get(m[1]);
      if (!run?.session) return send(res, 409, { error: 'This run is no longer open for review. Start a new run.' });
      touch(run);
      const b = await body(req);
      try {
        if (m[2] === 'review') await run.session.rebuild(b.decisions ?? {});
        else await run.session.raisePR({ title: String(b.title ?? ''), body: String(b.body ?? ''), branch: b.branch ? String(b.branch) : undefined, repo: b.repo ? String(b.repo) : undefined });
        return send(res, 200, { ok: true });
      } catch (e: any) { return send(res, 400, { error: e.message }); }
    }

    m = p.match(/^\/runs\/([\w-]+)\/(artifacts\/[\w.-]+|fixes\.patch|PR\.md|accessify-fixes\.js)$/);
    if (m) {
      const f = resolve(RUNS, m[1], m[2]);
      if (!f.startsWith(RUNS + sep) || !existsSync(f)) return void res.writeHead(404).end();
      const headers: Record<string, string> = { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' };
      if (m[2] === 'fixes.patch') headers['content-disposition'] = 'attachment; filename="accessify-fixes.patch"';
      if (m[2] === 'PR.md') headers['content-disposition'] = 'attachment; filename="accessify-report.md"';
      if (m[2] === 'accessify-fixes.js') headers['content-disposition'] = 'attachment; filename="accessify-fixes.js"';
      res.writeHead(200, headers);
      return void createReadStream(f).pipe(res);
    }

    const rel = p === '/' ? 'index.html' : p.slice(1);
    const f = resolve(PUBLIC, rel);
    if (!f.startsWith(PUBLIC + sep) && f !== PUBLIC) return void res.writeHead(403).end();
    if (!existsSync(f) || !statSync(f).isFile()) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(f));
  } catch (e: any) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  const l = llmInfo();
  console.log(`Accessify running at http://127.0.0.1:${PORT}  (${l.mode === 'gemini' ? `Gemini ${l.model} + heuristics` : 'heuristics only; add a Gemini key in Settings'})`);
});
