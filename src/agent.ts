import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Emit, Fix, Issue, PageScan } from './types.ts';
import { FIXABLE, applyEdit, planFix } from './fixers.ts';
import { advise, llmInfo, llmOn } from './llm.ts';
import { githubToken } from './settings.ts';
import { launch, scanPage, spoken } from './scan.ts';
import type { Browser } from 'playwright-core';
import type { Server } from 'node:http';
import { applyTemplate, isTemplate, scanTemplate } from './templates.ts';
import { previewFix } from './preview.ts';
import { siteTarget, snapshotSite } from './site.ts';
import { buildOverlay } from './overlay.ts';
import { SourceFile } from './source.ts';
import { commitFixes, initBaseline, discoverPages, discoverTemplates, openPullRequest, prepareWorkspace, previewDiff, resetTree, restoreFile, serveDir } from './workspace.ts';

const MAX_ROUNDS = 3;

interface Rec {
  id: string;
  issue: Issue;
  status: 'found' | 'planned' | 'applied' | 'verified' | 'failed' | 'manual' | 'reverted' | 'rejected';
  rejected?: boolean;
  fix?: Fix;
  attempts: number;
  note?: string;
}

const short = (s: string, n = 220) => (s.length > n ? s.slice(0, n) + '…' : s);
const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / (xs.length || 1));

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export interface Decision { rejected?: boolean; value?: string }
export interface Session {
  rebuild(decisions: Record<string, Decision>): Promise<void>;
  raisePR(o: { title: string; body: string; branch?: string; repo?: string }): Promise<void>;
  close(): Promise<void>;
}

/** Runs scan → fix → re-test, then stays open so a reviewer can edit fixes and raise the PR. */
export async function runAccessify(opts: { target: string; runDir: string; pace?: number }, emit: Emit): Promise<Session> {
  const art = join(opts.runDir, 'artifacts');
  mkdirSync(art, { recursive: true });
  const llm = llmInfo();
  const pace = opts.pace ?? 0;
  const beat = (k = 1) => (pace ? new Promise((r) => setTimeout(r, pace * k)) : undefined);
  const phase = async (d: Record<string, unknown>) => { emit('phase', d); await beat(4); };
  emit('start', { target: opts.target, llm, rounds: MAX_ROUNDS });

  const siteUrl = siteTarget(opts.target);
  let origin = '', server: Server | undefined, browser: Browser | undefined;
  let remote: Map<string, string> | undefined, siteHost = '';
  let ws: Awaited<ReturnType<typeof prepareWorkspace>>, pages: string[], templates: string[] = [];
  const closeAll = async () => { await browser?.close().catch(() => {}); server?.close(); };

  try {
    if (siteUrl) {
      // A live website: render it in Chrome and keep a static copy of each page to scan, fix and verify.
      await phase({ phase: 'prepare', label: `Capturing ${new URL(siteUrl).host}` });
      browser = await launch();
      const snap = await snapshotSite(browser, siteUrl, join(opts.runDir, 'site'), emit);
      ws = await initBaseline(join(opts.runDir, 'site'), 'baseline: snapshot of the live site');
      pages = snap.files; remote = snap.remote; siteHost = snap.host;
      emit('log', { msg: `Captured ${pages.length} page${pages.length === 1 ? '' : 's'} from ${siteHost}. Fixes will be shipped as a drop-in script, since there is no source to edit.` });
    } else {
      await phase({ phase: 'prepare', label: 'Preparing workspace' });
      ws = await prepareWorkspace(opts.target, join(opts.runDir, 'site'));
      pages = discoverPages(ws.dir); templates = discoverTemplates(ws.dir);
    }
  } catch (e) { await closeAll(); throw e; }
  const files = [...pages, ...templates];
  if (!files.length) { await closeAll(); throw new Error('No .html pages or template files (.jsx, .tsx, .vue, .svelte, .astro, .php, .hbs, .njk, .ejs, .erb, .liquid, .twig) found in this project.'); }
  emit('log', { msg: `Workspace ready: ${pages.length} rendered page${pages.length === 1 ? '' : 's'} + ${templates.length} source file${templates.length === 1 ? '' : 's'}` });
  const baseText = new Map(files.map((f) => [f, readFileSync(join(ws.dir, f), 'utf8')]));

  // Chrome and the local server are only started if there is an HTML page to render.
  if (pages.length) { ({ origin, server } = await serveDir(ws.dir)); browser ??= await launch(); }
  const applyTo = (file: string, text: string, patches: any[]) => isTemplate(file) ? applyTemplate(text, patches) : new SourceFile(text).apply(patches);
  const recs = new Map<string, Rec>();
  let seq = 0;
  const idOf = (i: Issue) => {
    let r = recs.get(i.key);
    if (!r) { r = { id: `i${++seq}`, issue: i, status: 'found', attempts: 0 }; recs.set(i.key, r); }
    return r;
  };
  const view = (r: Rec) => ({
    id: r.id, file: r.issue.file, rule: r.issue.rule, impact: r.issue.impact, help: r.issue.help, helpUrl: r.issue.helpUrl,
    html: short(r.issue.html), selector: r.issue.selector, status: r.status, note: r.note,
    fix: r.fix && r.fix.status === 'planned' ? { description: r.fix.description, method: r.fix.method, confidence: r.fix.confidence, edit: r.fix.edit } : undefined,
    snippet: r.fix?.status === 'planned' ? previewFix(r.issue, r.fix, baseText.get(r.issue.file) ?? '') : undefined,
    rect: r.issue.rect, line: r.issue.src?.line,
  });
  const mark = (r: Rec, status: Rec['status'], note?: string) => { r.status = status; if (note) r.note = note; emit('issue', { issue: view(r) }); };

  const scans = new Map<string, PageScan>();
  const first = new Map<string, PageScan>();
  let shotN = 0;
  const scan = async (file: string, round: number, label?: string) => {
    const shotName = `shot-${round}-${shotN++}.jpg`;
    let s: PageScan;
    if (isTemplate(file)) {
      const t = scanTemplate(ws.dir, file, readFileSync(join(ws.dir, file), 'utf8'));
      s = { file, url: '', title: file, h1: '', passes: t.passes, violations: t.counts, issues: t.issues, score: t.score, shot: '', aria: '', static: true };
    } else {
      s = await scanPage(browser!, `${origin}/${file}`, file, join(art, shotName));
      s.shot = shotName;
    }
    scans.set(file, s);
    if (!first.has(file)) first.set(file, s);
    emit('scan', { round, label, file, score: s.score, violations: s.issues.length, rules: s.violations.length, shot: s.static ? '' : shotName, static: !!s.static, size: s.size });
    return s;
  };
  const total = () => avg([...scans.values()].map((s) => s.score));
  const scoreEvent = (round: number, label: string) =>
    emit('score', { round, label, score: total(), pages: [...scans.values()].map((s) => ({ file: s.file, score: s.score, issues: s.issues.length })) });

  try {
    // 1. CRAWL
    await phase({ phase: 'crawl', label: 'Scanning pages (axe-core) and source files' });
    for (const f of files) await scan(f, 0);
    for (const s of scans.values()) for (const i of s.issues) idOf(i);
    for (const r of recs.values()) emit('issue', { issue: view(r) });
    scoreEvent(0, 'Baseline');
    emit('log', { msg: `Baseline score ${total()}/100 · ${recs.size} violating elements across ${new Set([...recs.values()].map((r) => r.issue.rule)).size} rules` });

    // 2. CLASSIFY
    await phase({ phase: 'classify', label: 'Classifying issues' });
    for (const r of recs.values()) {
      if (!FIXABLE.has(r.issue.rule)) mark(r, 'manual', 'Needs human judgement; the agent will not guess.');
    }
    const fixableN = [...recs.values()].filter((r) => FIXABLE.has(r.issue.rule)).length;
    emit('log', { msg: `${fixableN} auto-fixable · ${recs.size - fixableN} flagged for a human` });
    if (llmOn()) {
      const humans = [...recs.values()].filter((r) => r.status === 'manual').slice(0, 10);
      if (humans.length) {
        emit('log', { msg: `Asking Gemini how a developer should handle ${humans.length} flagged issue${humans.length > 1 ? 's' : ''}…` });
        await pool(humans, 3, async (r) => {
          try { const tip = await advise({ rule: r.issue.rule, help: r.issue.help, html: r.issue.html, page: r.issue.file }); if (tip) mark(r, 'manual', tip); } catch { /* keep the generic note */ }
        });
      }
    }

    // 3-4. FIX + RE-TEST LOOP
    let round = 0;
    while (round < MAX_ROUNDS) {
      const todo = [...recs.values()].filter((r) =>
        FIXABLE.has(r.issue.rule) && (r.status === 'found' || (r.status === 'failed' && r.issue.rule === 'color-contrast' && r.attempts < 2)));
      if (!todo.length) break;
      round++;
      emit('round', { round, todo: todo.length });
      await phase({ phase: 'fix', label: `Round ${round}: fix agents working`, round });

      await pool(todo, 4, async (r) => {
        r.attempts++;
        emit('log', { msg: `[${r.id}] ${r.issue.rule} on ${r.issue.file}: planning fix${llm.mode === 'gemini' && ['image-alt', 'button-name', 'link-name', 'document-title'].includes(r.issue.rule) ? ' with Gemini' : ''}…` });
        const fix = await planFix(r.issue, r.attempts, scans.get(r.issue.file)?.h1 || scans.get(r.issue.file)?.title || '');
        r.fix = fix;
        if (fix.status === 'manual') { mark(r, 'manual', fix.note); emit('log', { level: 'warn', msg: `[${r.id}] no safe fix: ${fix.note}` }); }
        else { mark(r, 'planned'); emit('log', { msg: `[${r.id}] ${fix.method}: ${fix.description}` }); }
        if (todo.length <= 60) await beat(1);
      });

      // apply patches per file, keep originals for revert
      const planned = todo.filter((r) => r.status === 'planned');
      const byFile = new Map<string, Rec[]>();
      for (const r of planned) byFile.set(r.issue.file, [...(byFile.get(r.issue.file) ?? []), r]);
      const originals = new Map<string, string>();
      await phase({ phase: 'apply', label: `Round ${round}: applying edits`, round });
      for (const [file, rs] of byFile) {
        const abs = join(ws.dir, file);
        const before = readFileSync(abs, 'utf8');
        originals.set(file, before);
        const { out, failed } = applyTo(file, before, rs.map((r) => r.fix!.patch!));
        for (const f of failed) {
          const r = rs.find((x) => x.fix!.patch === f.patch);
          if (r) { mark(r, 'failed', f.reason); emit('log', { level: 'warn', msg: `[${r.id}] edit refused: ${f.reason}` }); }
        }
        writeFileSync(abs, out);
        emit('log', { msg: `Edited ${file}: ${rs.filter((r) => r.status === 'planned').length} patches` });
        for (const r of rs) if (r.status === 'planned') mark(r, 'applied');
        if (rs.length <= 60) await beat(3);
      }

      // re-test
      await phase({ phase: 'retest', label: `Round ${round}: re-scanning to prove it`, round });
      for (const [file, rs] of byFile) {
        const prevKeys = new Set(scans.get(file)!.issues.map((i) => i.key));
        let s = await scan(file, round);
        const regressions = s.issues.filter((i) => !prevKeys.has(i.key));
        const applied = rs.filter((r) => r.status === 'applied');
        if (regressions.length) {
          emit('log', { level: 'warn', msg: `${file}: fixes introduced ${regressions.length} new violation(s) (${[...new Set(regressions.map((x) => x.rule))].join(', ')}). Reverting this file.` });
          writeFileSync(join(ws.dir, file), originals.get(file)!);
          s = await scan(file, round);
          for (const r of applied) mark(r, 'reverted', 'Fix caused a regression and was rolled back.');
          continue;
        }
        const still = new Set(s.issues.map((i) => i.key));
        for (const r of applied) {
          if (still.has(r.issue.key)) { mark(r, 'failed', 'Still reported after the fix.'); emit('log', { level: 'warn', msg: `[${r.id}] ${r.issue.rule} still fails after fix` }); }
          else { mark(r, 'verified'); emit('log', { level: 'ok', msg: `[${r.id}] ${r.issue.rule} verified gone` }); }
          if (applied.length <= 60) await beat(0.7);
        }
        for (const i of s.issues) {
          if (!recs.has(i.key)) { const nr = idOf(i); emit('issue', { issue: view(nr) }); if (!FIXABLE.has(i.rule)) mark(nr, 'manual', 'Needs human judgement; the agent will not guess.'); emit('log', { msg: `New issue surfaced after fixes: ${i.rule}` }); }
        }
      }
      scoreEvent(round, `After round ${round}`);
      emit('log', { level: 'ok', msg: `Round ${round} done · score ${total()}/100` });
    }

    // 5. REVIEW: everything is applied in the workspace but nothing is committed or pushed yet.
    let rounds = round, rev = 0, busy = false, last: Record<string, unknown> = {};
    const before = () => avg([...first.values()].map((s) => s.score));

    const finalize = async (kind: 'initial' | 'rebuilt') => {
      const all = [...recs.values()];
      const verified = all.filter((r) => r.status === 'verified');
      const open = all.filter((r) => ['manual', 'failed', 'reverted'].includes(r.status));
      const skipped = all.filter((r) => r.status === 'rejected');
      const edited = verified.filter((r) => r.fix?.method === 'human');
      const b = before(), af = total();
      const title = siteHost
        ? `Accessibility fixes for ${siteHost}: ${verified.length} issue${verified.length === 1 ? '' : 's'} (score ${b} → ${af})`
        : `a11y: fix ${verified.length} accessibility issue${verified.length === 1 ? '' : 's'} (score ${b} → ${af})`;
      const body = prBody({ before: b, after: af, verified, manual: open, llm, pages: files.length, edited: edited.length, skipped: skipped.length, site: siteHost });
      let overlay: { pages: number; fixes: number; bytes: number } | undefined;
      if (remote) {
        const o = buildOverlay(siteHost, verified.filter((r) => r.fix?.patch).map((r) => ({ file: r.issue.file, issue: r.issue, fix: r.fix! })), remote);
        writeFileSync(join(opts.runDir, 'accessify-fixes.js'), o.script);
        overlay = { pages: o.pages, fixes: o.fixes, bytes: o.script.length };
      }
      const patch = await previewDiff(ws);
      writeFileSync(join(opts.runDir, 'PR.md'), body);
      writeFileSync(join(opts.runDir, 'fixes.patch'), patch);
      emit('diff', { patch, branch: 'accessify/a11y-fixes' });
      emit('transcript', { pages: [...first.keys()].filter((f) => !isTemplate(f)).map((f) => ({ file: f, before: spoken(first.get(f)!.aria), after: spoken(scans.get(f)!.aria) })) });
      emit('shots', { pages: [...first.keys()].map((f) => ({ file: f, static: isTemplate(f), size: first.get(f)!.size, before: first.get(f)!.shot, after: scans.get(f)!.shot, beforeScore: first.get(f)!.score, afterScore: scans.get(f)!.score })) });
      emit('draft', { title, body, branch: 'accessify/a11y-fixes', repo: ws.repoSlug, needsRepo: !ws.repoSlug, changes: verified.length, site: siteHost ? { host: siteHost, ...overlay } : undefined });
      last = { before: b, after: af, fixed: verified.length, manual: open.length, skipped: skipped.length, total: all.length, rounds, kind, hasToken: !!githubToken() };
      emit('review', last);
    };

    await phase({ phase: 'review', label: 'Ready for your review' });
    await finalize('initial');

    // Same retest as above, but starting from the baseline with the reviewer's choices.
    const rebuild = async (decisions: Record<string, Decision>) => {
      if (busy) throw new Error('Still working on your previous change. Wait a moment.');
      busy = true;
      try {
        const staged = new Map<string, Fix>();
        const byId = new Map([...recs.values()].map((r) => [r.id, r]));
        for (const [id, d] of Object.entries(decisions)) {
          const r = byId.get(id);
          if (!r?.fix?.patch) continue;
          if (d.value != null && r.fix.edit && d.value.trim() !== r.fix.edit.value) {
            try { staged.set(id, applyEdit(r.fix, d.value)); } catch (e: any) { throw new Error(`${r.issue.rule} in ${r.issue.file}: ${e.message}`); }
          }
        }
        for (const [id, d] of Object.entries(decisions)) {
          const r = byId.get(id); if (!r?.fix?.patch) continue;
          r.rejected = !!d.rejected;
          if (staged.has(id)) r.fix = staged.get(id);
        }
        rev++;
        await phase({ phase: 'rebuild', label: `Re-applying your changes (${rev})` });
        await resetTree(ws);

        const eligible = [...recs.values()].filter((r) => r.fix?.status === 'planned' && r.fix.patch && !r.rejected &&
          (r.status === 'verified' || r.status === 'rejected' || staged.has(r.id)));
        for (const r of recs.values()) if (r.rejected && r.fix?.patch) mark(r, 'rejected', 'Excluded by you; not in the PR.');
        const byFile = new Map<string, Rec[]>();
        for (const r of eligible) byFile.set(r.issue.file, [...(byFile.get(r.issue.file) ?? []), r]);
        for (const [file, rs] of byFile) {
          const abs = join(ws.dir, file);
          const { out, failed } = applyTo(file, readFileSync(abs, 'utf8'), rs.map((r) => r.fix!.patch!));
          for (const f of failed) { const r = rs.find((x) => x.fix!.patch === f.patch); if (r) mark(r, 'failed', f.reason); }
          writeFileSync(abs, out);
          for (const r of rs) if (r.status !== 'failed') mark(r, 'applied');
        }
        emit('log', { msg: `Re-applied ${eligible.length} fix${eligible.length === 1 ? '' : 'es'}; re-scanning to verify` });

        await phase({ phase: 'retest', label: 'Re-scanning with your changes', round: rounds + rev });
        for (const file of files) {
          const rs = byFile.get(file) ?? [];
          let s = await scan(file, rounds + rev, 'after your changes');
          const baseKeys = new Set(first.get(file)!.issues.map((i) => i.key));
          const regress = s.issues.filter((i) => !baseKeys.has(i.key));
          if (regress.length) {
            emit('log', { level: 'warn', msg: `${file}: your changes introduced ${regress.length} new violation(s) (${[...new Set(regress.map((x) => x.rule))].join(', ')}). Reverting this file.` });
            await restoreFile(ws, file);
            s = await scan(file, rounds + rev, 'after revert');
            for (const r of rs) mark(r, 'reverted', 'Caused a new violation and was rolled back.');
            continue;
          }
          const still = new Set(s.issues.map((i) => i.key));
          for (const r of rs) {
            if (r.status !== 'applied') continue;
            if (still.has(r.issue.key)) { mark(r, 'failed', 'Still reported after your change.'); emit('log', { level: 'warn', msg: `[${r.id}] ${r.issue.rule} still fails` }); }
            else mark(r, 'verified');
          }
        }
        scoreEvent(rounds + rev, 'After your changes');
        await phase({ phase: 'review', label: 'Ready for your review' });
        await finalize('rebuilt');
      } finally { busy = false; }
    };

    const raisePR = async (o: { title: string; body: string; branch?: string; repo?: string }) => {
      if (siteHost) throw new Error('A live website has no repository to open a PR against. Download the fix script, patch and report from the Ship fixes tab instead.');
      if (busy) throw new Error('Still working. Wait a moment.');
      const token = githubToken();
      if (!token) throw new Error('Add a GitHub token in Settings first.');
      if (!o.title.trim()) throw new Error('The PR needs a title.');
      busy = true;
      try {
        await phase({ phase: 'pr', label: 'Raising the pull request' });
        emit('log', { msg: 'Committing the reviewed fixes on a clean branch' });
        const commit = await commitFixes(ws, `${o.title}\n\nAutomated by Accessify. Every fix was re-tested with axe-core.`, o.branch);
        if (!commit.changed) throw new Error('Nothing to commit. Every change is excluded or rolled back.');
        emit('log', { msg: 'Pushing and opening the pull request on GitHub…' });
        const res = await openPullRequest(ws, { branch: commit.branch, title: o.title, body: o.body, patch: commit.patch, token, repo: o.repo, runDir: opts.runDir });
        writeFileSync(join(opts.runDir, 'PR.md'), o.body);
        emit('log', { level: 'ok', msg: `${res.reused ? 'Updated the existing' : 'Opened'} pull request: ${res.url}${res.fork ? ' (from your fork)' : ''}` });
        emit('pr', { mode: 'opened', title: o.title, body: o.body, ...res, branch: commit.branch });
      } catch (e: any) {
        emit('pr', { mode: 'failed', title: o.title, body: o.body, note: e.message });
        emit('review', last);
        throw e;
      } finally { busy = false; }
    };

    return { rebuild, raisePR, close: closeAll };
  } catch (e) {
    await closeAll();
    throw e;
  }
}

function prBody(o: { before: number; after: number; verified: any[]; manual: any[]; llm: any; pages: number; edited: number; skipped: number; site?: string }) {
  const row = (r: any) => `| \`${r.issue.rule}\` | \`${r.issue.file}\` | ${r.fix?.description?.replace(/\|/g, '\\|') ?? ''} | ${r.fix?.method ?? ''} |`;
  return [
    `## Accessibility fixes (automated)`, '',
    ...(o.site ? [`Scanned the live site **${o.site}**: each page was rendered in Chrome and the fixes below were proven on a static copy. They ship as \`accessify-fixes.js\` (applied at runtime) and as a patch against that rendered copy; apply them in your source for a permanent fix.`, ''] : []),
    `Accessibility score **${o.before} → ${o.after}** across ${o.pages} page${o.pages > 1 ? 's' : ''}, measured with axe-core (WCAG 2.0/2.1 A and AA).`, '',
    `Each fix below was applied as a minimal source edit and then **re-tested with a fresh axe-core scan**; only fixes whose violation disappeared are included. A file whose fixes caused any new violation was rolled back.`, '',
    `### Fixed and verified (${o.verified.length})`, '', `| Rule | File | Change | How |`, `|---|---|---|---|`, ...o.verified.map(row), '',
    `### Needs a human (${o.manual.length})`, '',
    ...(o.manual.length ? o.manual.map((r) => `- \`${r.issue.rule}\` in \`${r.issue.file}\`: ${r.note ?? r.issue.help}`) : ['Nothing left.']), '',
    `### Review notes`, '',
    `- Reviewed in the Accessify dashboard before opening this PR: ${o.edited} fix${o.edited === 1 ? '' : 'es'} edited by hand, ${o.skipped} excluded.`,
    `- Names and alt text marked "heuristic" were inferred from markup, not from the image. Please read them.`,
    `- Colour fixes are added as \`a11y-*\` classes in a \`<style data-accessify>\` block so they are easy to move into your stylesheet.`,
    `- Gemini (${o.llm.mode === 'gemini' ? o.llm.model : 'not used for this run'}) wrote alt text, names and titles where a fix is marked vision or llm; everything else is deterministic or heuristic.`, '',
    `_Generated by Accessify._`,
  ].join('\n');
}
