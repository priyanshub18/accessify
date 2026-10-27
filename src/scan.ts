import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium, type Browser } from 'playwright-core';
import type { Issue, PageScan } from './types.ts';
import { scorePage } from './score.ts';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export async function launch(): Promise<Browser> {
  const exe = process.env.CHROME_PATH;
  try {
    return await chromium.launch(exe ? { executablePath: exe } : { channel: 'chrome' });
  } catch (e: any) {
    throw new Error(`Could not start Chrome (${e.message.split('\n')[0]}). Install Google Chrome or set CHROME_PATH.`);
  }
}

export async function scanPage(browser: Browser, url: string, file: string, shotPath: string): Promise<PageScan> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.addScriptTag({ content: AXE });
    const raw = await page.evaluate(async (tags: string[]) => {
      const axe = (window as any).axe;
      const ids = axe.getRules(tags).map((r: any) => r.ruleId).concat(['tabindex', 'heading-order', 'empty-heading', 'page-has-heading-one']);
      const res = await axe.run(document, { runOnly: { type: 'rule', values: ids }, resultTypes: ['violations', 'passes'] });
      const pathOf = (el: Element) => {
        const p: number[] = [];
        for (let n: Element | null = el; n && n.parentElement; n = n.parentElement) p.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
        return p;
      };
      const txt = (s: string | null | undefined, n = 160) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
      const violations = res.violations.map((v: any) => ({
        id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
        nodes: v.nodes.map((n: any) => {
          const el: Element | null = n.target.length === 1 ? document.querySelector(n.target[0]) : null;
          if (!el) return null;
          const checks = [...n.any, ...n.all, ...n.none];
          const data = checks.map((c: any) => c.data).find((d: any) => d && typeof d === 'object') ?? null;
          let prev = el.previousElementSibling;
          while (prev && prev.tagName === 'BR') prev = prev.previousElementSibling;
          const link = el.closest('a');
          return {
            selector: n.target[0], path: pathOf(el), html: n.html, data,
            rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; })(),
            ctx: {
              tag: el.tagName.toLowerCase(),
              attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
              text: txt(el.textContent, 80),
              parentText: txt(el.parentElement?.textContent),
              prevLabel: prev && prev.tagName === 'LABEL' ? txt(prev.textContent, 60) : '',
              html: el.outerHTML.slice(0, 500),
              ownBg: getComputedStyle(el).backgroundColor,
              inLink: link ? link.getAttribute('href') : null,
            },
          };
        }).filter(Boolean),
      }));
      return { violations, size: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }, passes: res.passes.length, title: document.title, h1: txt(document.querySelector('h1')?.textContent, 80) };
    }, TAGS);

    const issues: Issue[] = [];
    for (const v of raw.violations) {
      for (const n of v.nodes) {
        const issue: Issue = { ...n, file, rule: v.id, impact: v.impact ?? 'minor', help: v.help, helpUrl: v.helpUrl, key: `${file}|${v.id}|${n.path.join('.')}` };
        if (v.id === 'image-alt' || (v.id === 'button-name' || v.id === 'link-name')) {
          try { issue.imageB64 = (await page.locator(n.selector).first().screenshot({ type: 'png', timeout: 3000 })).toString('base64'); issue.imageMime = 'image/png'; } catch { /* element not visible */ }
        }
        issues.push(issue);
      }
    }

    const aria = await page.locator('body').ariaSnapshot().catch(() => '');
    await page.evaluate((paths: number[][]) => {
      for (const p of paths) {
        let el: Element | undefined = document.documentElement;
        for (const i of p) el = el?.children[i];
        if (el instanceof HTMLElement) { el.style.outline = '3px solid #e5484d'; el.style.outlineOffset = '2px'; }
      }
    }, issues.map((i) => i.path));
    await page.screenshot({ path: shotPath, type: 'jpeg', quality: 72, fullPage: true });

    const counts = raw.violations.map((v: any) => ({ id: v.id as string, impact: (v.impact ?? 'minor') as string, nodes: v.nodes.length as number }));
    return { file, url, title: raw.title, h1: raw.h1, passes: raw.passes, violations: counts, issues, score: scorePage(raw.passes, counts), shot: shotPath, aria, size: raw.size };
  } finally {
    await ctx.close();
  }
}

const ROLES_NEEDING_NAME = new Set(['img', 'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'searchbox', 'slider', 'spinbutton']);

/** Turn Playwright's aria snapshot into screen-reader style lines, flagging unnamed controls. */
export function spoken(snapshot: string) {
  const out: { indent: number; text: string; warn: boolean }[] = [];
  const open: number[] = []; // indent levels of enclosing buttons/links: their children are not announced separately
  for (const line of snapshot.split('\n')) {
    if (!line.trim() || /^\s*- \//.test(line)) continue;
    const m = line.match(/^(\s*)- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/);
    if (!m) continue;
    const [, sp, role, name = '', rest] = m;
    while (open.length && open[open.length - 1] >= sp.length) open.pop();
    if (open.length && role === 'img') continue;
    if (role === 'button' || role === 'link') open.push(sp.length);
    const level = rest.match(/\[level=(\d)\]/)?.[1];
    if (role === 'text') { out.push({ indent: sp.length / 2, text: rest.replace(/^:\s*/, ''), warn: false }); continue; }
    const warn = ROLES_NEEDING_NAME.has(role) && !name;
    const label = role === 'heading' && level ? `heading level ${level}` : role;
    out.push({ indent: sp.length / 2, text: warn ? `${label}, unlabeled` : name ? `${label}, ${name}` : label, warn });
  }
  return out;
}
