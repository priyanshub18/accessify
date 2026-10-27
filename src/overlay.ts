import { pathKey } from './site.ts';
import type { Fix, Issue } from './types.ts';

interface PageFix { lang?: string; title?: string; css: string[]; edits: { s: string; set?: Record<string, string>; rm?: string[]; cls?: string }[] }
export interface Overlay { script: string; pages: number; fixes: number }

/** A drop-in script that applies the verified fixes to the live site, matched by URL path and CSS selector. */
export function buildOverlay(host: string, items: { file: string; issue: Issue; fix: Fix }[], remote: Map<string, string>): Overlay {
  const pages: Record<string, PageFix> = {};
  let fixes = 0;
  for (const { file, issue, fix } of items) {
    const p = fix.patch, url = remote.get(file);
    if (!p || !url) continue;
    const page = (pages[pathKey(new URL(url))] ??= { css: [], edits: [] });
    fixes++;
    if (issue.rule === 'html-has-lang' && p.set?.lang) { page.lang = p.set.lang; continue; }
    if (issue.rule === 'document-title') { page.title = fix.edit?.value ?? ''; continue; }
    if (p.cssRule && !page.css.includes(p.cssRule)) page.css.push(p.cssRule);
    // <base> is only present in our snapshot, so head selectors are written by attribute instead of position
    const s = issue.rule === 'meta-viewport' ? 'meta[name="viewport" i]' : issue.selector;
    page.edits.push({ s, set: p.set, rm: p.removeAttrs, cls: p.addClass });
  }
  const data = JSON.stringify(pages);
  const script = `/* Accessify fixes for ${host} · ${fixes} verified fixes on ${Object.keys(pages).length} page(s) · generated ${new Date().toISOString().slice(0, 10)}
   Add before </body>:  <script src="/accessify-fixes.js" defer></script>
   Each fix was proven against a rendered copy of the page. Fixes are matched by CSS selector, so re-run Accessify after big layout changes. */
(function () {
  var DATA = ${data};
  var key = location.pathname.replace(/\\/index\\.html?$/i, '').replace(/\\/+$/, '') || '/';
  var page = DATA[key];
  if (!page) return;
  var pending = page.edits.slice(), tries = 0;
  function ok(name) { return /^(alt|aria-[a-z]+|title|lang|tabindex|content|class|role)$/i.test(name); }
  function applyAll() {
    if (page.lang && !document.documentElement.getAttribute('lang')) document.documentElement.setAttribute('lang', page.lang);
    if (page.title && !document.title) document.title = page.title;
    if (page.css.length && !document.querySelector('style[data-accessify]')) {
      var st = document.createElement('style'); st.setAttribute('data-accessify', ''); st.textContent = page.css.join('\\n'); document.head.appendChild(st);
    }
    pending = pending.filter(function (e) {
      var el; try { el = document.querySelector(e.s); } catch (x) { return false; }
      if (!el) return true;
      if (e.set) for (var k in e.set) if (ok(k)) el.setAttribute(k, e.set[k]);
      if (e.rm) e.rm.forEach(function (n) { el.removeAttribute(n); });
      if (e.cls) e.cls.split(/\\s+/).forEach(function (c) { if (c) el.classList.add(c); });
      return false;
    });
    return pending.length === 0;
  }
  // Single-page apps render late: keep trying for a few seconds as the DOM changes.
  if (applyAll()) return;
  var mo = new MutationObserver(function () { if (applyAll() || ++tries > 400) mo.disconnect(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(function () { applyAll(); mo.disconnect(); }, 15000);
})();
`;
  return { script, pages: Object.keys(pages).length, fixes };
}
