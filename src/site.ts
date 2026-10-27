import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Browser } from 'playwright-core';
import type { Emit } from './types.ts';

const REPO = /^https:\/\/github\.com\/[^/]+\/[^/#?]+/;

/** A live website target (not a GitHub repo, not a folder). Bare domains and localhost:port are accepted. */
export function siteTarget(raw: string): string | null {
  const t = raw.trim();
  if (!t || /\s/.test(t)) return null;
  if (REPO.test(t)) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(t)) return 'http://' + t;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t) && !/^[./~]/.test(t) && !/\.(html?|jsx?|tsx?|vue|svelte)$/i.test(t)) return 'https://' + t;
  return null;
}

const SKIP_EXT = /\.(pdf|zip|gz|tar|png|jpe?g|gif|webp|svg|ico|mp4|webm|mp3|wav|css|js|json|xml|txt|woff2?|ttf|docx?|xlsx?|pptx?)$/i;

/** pathname → stable key used for de-duplication and for matching the fix script at runtime */
export const pathKey = (u: URL) => (u.pathname.replace(/\/index\.html?$/i, '').replace(/\/+$/, '') || '/');

function fileFor(u: URL, used: Set<string>): string {
  let p = u.pathname.replace(/\/$/, '/index');
  if (!/\.html?$/i.test(p)) p += '.html';
  p = p.replace(/^\/+/, '').replace(/[^\w./-]+/g, '_') || 'index.html';
  let out = p, n = 1;
  while (used.has(out)) out = p.replace(/\.html?$/i, `-${++n}.html`);
  used.add(out);
  return out;
}

export interface Snapshot { files: string[]; remote: Map<string, string>; host: string }

/**
 * Render each page in Chrome (so React/Vue/etc. have hydrated), then save the resulting DOM as a static
 * HTML file. Scripts are switched off in place (not removed) so element positions stay identical to the live
 * page, and a <base> tag lets the copy load its CSS, fonts and images from the real site.
 */
export async function snapshotSite(browser: Browser, startUrl: string, dest: string, emit: Emit, max = 6): Promise<Snapshot> {
  mkdirSync(dest, { recursive: true });
  const start = new URL(startUrl);
  let origin = start.origin;
  const queue: string[] = [start.href];
  const seen = new Set<string>([pathKey(start)]);
  const used = new Set<string>();
  const files: string[] = [], remote = new Map<string, string>();

  while (queue.length && files.length < max) {
    const url = queue.shift()!;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    try {
      emit('log', { msg: `Opening ${url}` });
      const resp = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
      if (!resp) throw new Error('no response');
      if (resp.status() >= 400) throw new Error(`HTTP ${resp.status()}`);
      await page.waitForLoadState('networkidle', { timeout: 7000 }).catch(() => {});
      // trigger lazy content once
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight && y < 8000; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); }).catch(() => {});
      const finalUrl = new URL(page.url());
      if (!files.length) { origin = finalUrl.origin; seen.add(pathKey(finalUrl)); }
      const snap = await page.evaluate((pageUrl: string) => {
        const links = [...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href);
        document.querySelectorAll('script').forEach((s) => { s.setAttribute('type', 'text/plain'); s.setAttribute('data-accessify-off', ''); });
        document.querySelectorAll('meta[http-equiv]').forEach((m) => { if (/content-security-policy/i.test(m.getAttribute('http-equiv') ?? '')) m.remove(); });
        document.querySelectorAll('link[rel=modulepreload],link[rel=preload][as=script]').forEach((l) => l.remove());
        if (!document.querySelector('base') && document.head) { const b = document.createElement('base'); b.href = pageUrl; document.head.prepend(b); }
        return { html: '<!DOCTYPE html>\n' + document.documentElement.outerHTML, links };
      }, finalUrl.href);
      const rel = fileFor(finalUrl, used);
      const abs = join(dest, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, snap.html);
      files.push(rel); remote.set(rel, finalUrl.href);
      emit('log', { msg: `Captured ${finalUrl.pathname || '/'} → ${rel} (${Math.round(snap.html.length / 1024)} KB)` });

      for (const href of snap.links) {
        let u: URL; try { u = new URL(href); } catch { continue; }
        if (!/^https?:$/.test(u.protocol) || u.origin !== origin || SKIP_EXT.test(u.pathname)) continue;
        const k = pathKey(u);
        if (seen.has(k) || seen.size >= max * 4) continue;
        seen.add(k); u.hash = ''; queue.push(u.href);
      }
    } catch (e: any) {
      if (!files.length) throw new Error(`Could not open ${url}: ${String(e.message).split('\n')[0]}`);
      emit('log', { level: 'warn', msg: `Skipped ${url}: ${String(e.message).split('\n')[0]}` });
    } finally { await ctx.close(); }
  }
  if (!files.length) throw new Error(`No pages could be captured from ${startUrl}`);
  return { files, remote, host: new URL(origin).host };
}
