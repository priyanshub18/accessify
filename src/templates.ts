import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { Issue, Patch } from './types.ts';
import { scorePage } from './score.ts';

/** Source files that hold markup but cannot be rendered without a build: scanned statically. */
export const TEMPLATE_EXT = /\.(jsx|tsx|vue|svelte|astro|php|hbs|njk|ejs|erb|liquid|twig|blade\.php)$/i;
export const isTemplate = (f: string) => TEMPLATE_EXT.test(f);

export interface Attr { name: string; start: number; end: number; value: string | null; dynamic: boolean }
export interface Tag { name: string; start: number; end: number; attrs: Attr[]; selfClosing: boolean; spread: boolean; ordinal: number }

const INTEREST = new Set(['html', 'img', 'Image', 'a', 'button', 'input', 'select', 'textarea', 'iframe', 'meta', 'div', 'span', 'li', 'label']);

/** Skip a {...} or {{...}} expression, respecting string literals. Returns the index after the closing brace. */
function skipBraces(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { const q = c; for (i++; i < s.length && s[i] !== q; i++) if (s[i] === '\\') i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return s.length;
}

export function tokenize(src: string): Tag[] {
  const tags: Tag[] = [];
  const counts = new Map<string, number>();
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '<') continue;
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); i = e < 0 ? src.length : e + 2; continue; }
    if (src.startsWith('<?', i)) { const e = src.indexOf('?>', i); i = e < 0 ? src.length : e + 1; continue; }
    if (src.startsWith('<%', i)) { const e = src.indexOf('%>', i); i = e < 0 ? src.length : e + 1; continue; }
    const m = /^<([A-Za-z][\w.:-]*)/.exec(src.slice(i, i + 64));
    if (!m) continue;
    const name = m[1];
    let p = i + m[0].length;
    const attrs: Attr[] = [];
    let spread = false, closed = false, selfClosing = false;
    while (p < src.length && p - i < 4000) {
      while (p < src.length && /\s/.test(src[p])) p++;
      if (src.startsWith('/>', p)) { closed = true; selfClosing = true; p += 2; break; }
      if (src[p] === '>') { closed = true; p++; break; }
      if (src[p] === '{') { const e = skipBraces(src, p); spread = spread || src.startsWith('{...', p) || src.startsWith('{{', p); p = e; continue; }
      if (src.startsWith('<?', p)) { const e = src.indexOf('?>', p); p = e < 0 ? src.length : e + 2; spread = true; continue; }
      if (src.startsWith('<%', p)) { const e = src.indexOf('%>', p); p = e < 0 ? src.length : e + 2; spread = true; continue; }
      const nm = /^[^\s=/>{"'<]+/.exec(src.slice(p, p + 80));
      if (!nm) break;
      const start = p; p += nm[0].length;
      let value: string | null = null, dynamic = false;
      let q = p; while (q < src.length && /[ \t]/.test(src[q])) q++;
      if (src[q] === '=') {
        p = q + 1; while (/\s/.test(src[p] ?? '')) p++;
        if (src[p] === '"' || src[p] === "'") { const e = src.indexOf(src[p], p + 1); if (e < 0) break; value = src.slice(p + 1, e); dynamic = /\{\{|<\?|<%|\{%/.test(value); p = e + 1; }
        else if (src[p] === '{') { const e = skipBraces(src, p); value = src.slice(p, e); dynamic = true; p = e; }
        else { const bm = /^[^\s>]+/.exec(src.slice(p, p + 200)); if (bm) { value = bm[0]; p += bm[0].length; } }
      }
      attrs.push({ name: nm[0], start, end: p, value, dynamic });
    }
    if (!closed) continue;
    if (!INTEREST.has(name)) { i = p - 1 > i ? i : i; continue; }
    const n = counts.get(name) ?? 0; counts.set(name, n + 1);
    tags.push({ name, start: i, end: p, attrs, selfClosing, spread, ordinal: n });
    i = p - 1;
  }
  return tags;
}

const attr = (t: Tag, ...names: string[]) => t.attrs.find((a) => names.includes(a.name.toLowerCase()) || names.includes(a.name));
const has = (t: Tag, ...names: string[]) => !!attr(t, ...names);
const sval = (t: Tag, ...names: string[]) => { const a = attr(t, ...names); return a && !a.dynamic ? a.value ?? '' : null; };
const flat = (s: string, n = 240) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** Visible text content of an element, or null if it has dynamic content we cannot judge. */
function innerInfo(src: string, t: Tag): { text: string; dynamic: boolean; altImg: boolean } {
  if (t.selfClosing) return { text: '', dynamic: false, altImg: false };
  const close = src.toLowerCase().indexOf(`</${t.name.toLowerCase()}`, t.end);
  const inner = close < 0 ? '' : src.slice(t.end, close);
  const noComments = inner.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const altImg = /<(img|Image)\b[^>]*\balt\s*=\s*(?:"[^"]+"|'[^']+'|\{[^}]+\})/.test(noComments) || /\baria-label\s*=/.test(noComments);
  const dynamic = /\{[^}]+\}|\{\{|<\?|<%/.test(noComments.replace(/<[^>]*>/g, ''));
  const text = noComments.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  return { text, dynamic, altImg };
}

const HELP: Record<string, [string, string]> = {
  'html-has-lang': ['critical', '<html> element must have a lang attribute'],
  'image-alt': ['critical', 'Images must have alternative text'],
  'button-name': ['critical', 'Buttons must have discernible text'],
  'link-name': ['serious', 'Links must have discernible text'],
  label: ['critical', 'Form elements must have labels'],
  'select-name': ['critical', 'Select element must have an accessible name'],
  'frame-title': ['serious', 'Frames must have an accessible name'],
  'meta-viewport': ['critical', 'Zooming and scaling must not be disabled'],
  tabindex: ['serious', 'Elements should not have tabindex greater than zero'],
  'click-events-have-key-events': ['serious', 'Clickable non-interactive elements need a role and keyboard access'],
};

export interface TemplateScan { issues: Issue[]; passes: number; counts: { id: string; impact: string; nodes: number }[]; score: number }

/** Resolve an <img src> to a file in the repo so a vision model can look at it. */
function readImage(root: string, file: string, src: string): { b64: string; mime: string } | null {
  if (!src || /^(https?:)?\/\//.test(src) || src.startsWith('data:') || src.startsWith('{')) return null;
  const clean = src.split(/[?#]/)[0];
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extname(clean).toLowerCase()];
  if (!mime) return null;
  const roots = [join(root, dirname(file)), root, join(root, 'public'), join(root, 'static'), join(root, 'src'), join(root, 'src/assets'), join(root, 'assets')];
  for (const r of roots) {
    const p = resolve(r, clean.replace(/^\/+/, ''));
    if (!p.startsWith(resolve(root) + sep) || !existsSync(p) || !statSync(p).isFile() || statSync(p).size > 4_000_000) continue;
    return { b64: readFileSync(p).toString('base64'), mime };
  }
  return null;
}

export function scanTemplate(root: string, file: string, src: string): TemplateScan {
  const tags = tokenize(src);
  const issues: Issue[] = [];
  let passes = 0;
  const labelFor = new Set(tags.filter((t) => t.name === 'label').map((t) => sval(t, 'for', 'htmlFor', 'htmlfor')).filter(Boolean) as string[]);
  const lineOf = (o: number) => src.slice(0, o).split('\n').length;

  const add = (t: Tag, rule: string, extra: Partial<Issue> = {}) => {
    const [impact, help] = HELP[rule];
    const html = flat(src.slice(t.start, t.end), 300);
    const attrs: Record<string, string> = {};
    for (const a of t.attrs) { const v = (a.value ?? '').replace(/^\{|\}$/g, ''); attrs[a.name] = v; attrs[a.name.toLowerCase()] = v; }
    const near = flat(src.slice(Math.max(0, t.start - 160), t.start).replace(/<[^>]*>/g, ' '), 100);
    const inner = innerInfo(src, t);
    issues.push({
      key: `${file}|${rule}|${t.name}#${t.ordinal}`, file, rule, impact, help, helpUrl: `https://dequeuniversity.com/rules/axe/4.10/${rule}`,
      selector: `${t.name}:${lineOf(t.start)}`, path: [], html, data: null,
      src: { start: t.start, end: t.end, line: lineOf(t.start) },
      ctx: { tag: t.name === 'Image' ? 'img' : t.name, attrs, text: flat(inner.text, 80), parentText: near, prevLabel: '', html, ownBg: null, inLink: null },
      ...extra,
    } as Issue);
  };

  for (const t of tags) {
    const name = t.name;
    if (has(t, 'tabindex') ) {
      const v = sval(t, 'tabindex') ?? attr(t, 'tabindex', 'tabIndex')?.value?.replace(/[{}\s]/g, '') ?? '';
      if (/^[1-9]\d*$/.test(v)) add(t, 'tabindex'); else passes++;
    }
    if (name === 'html') { if (has(t, 'lang') || t.spread) passes++; else add(t, 'html-has-lang'); continue; }
    if (name === 'img' || name === 'Image') {
      if (has(t, 'alt') || t.spread) { passes++; continue; }
      const src0 = sval(t, 'src') ?? attr(t, 'src')?.value ?? '';
      const img = readImage(root, file, src0.replace(/^\{?["']|["']?\}?$/g, ''));
      add(t, 'image-alt', img ? { imageB64: img.b64, imageMime: img.mime } : {});
      continue;
    }
    if (name === 'a' || name === 'button') {
      if (has(t, 'aria-label', 'aria-labelledby', 'title') || t.spread || (name === 'a' && !has(t, 'href', 'to', 'routerLink', 'v-bind:href', ':href'))) { passes++; continue; }
      const inn = innerInfo(src, t);
      if (inn.text || inn.dynamic || inn.altImg) passes++; else add(t, name === 'a' ? 'link-name' : 'button-name');
      continue;
    }
    if (name === 'input' || name === 'select' || name === 'textarea') {
      const type = (sval(t, 'type') ?? 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type) || t.spread) { passes++; continue; }
      const id = sval(t, 'id');
      const before = src.slice(0, t.start).toLowerCase();
      const wrapped = before.lastIndexOf('<label') > before.lastIndexOf('</label');
      if (has(t, 'aria-label', 'aria-labelledby', 'title') || (id && labelFor.has(id)) || wrapped) { passes++; continue; }
      add(t, name === 'select' ? 'select-name' : 'label');
      continue;
    }
    if (name === 'iframe') { if (has(t, 'title') || t.spread) passes++; else add(t, 'frame-title'); continue; }
    if (name === 'meta') {
      if (sval(t, 'name')?.toLowerCase() === 'viewport') {
        const c = sval(t, 'content') ?? '';
        if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*[01](\.0*)?\b/i.test(c)) add(t, 'meta-viewport'); else passes++;
      }
      continue;
    }
    if (name === 'div' || name === 'span' || name === 'li') {
      if (has(t, 'onClick', 'onclick', '@click', 'v-on:click', '(click)') && !has(t, 'role') && !has(t, 'tabindex', 'tabIndex') && !t.spread) add(t, 'click-events-have-key-events');
    }
  }

  const by = new Map<string, number>();
  for (const i of issues) by.set(i.rule, (by.get(i.rule) ?? 0) + 1);
  const counts = [...by].map(([id, nodes]) => ({ id, impact: HELP[id][0], nodes }));
  return { issues, passes, counts, score: scorePage(passes, counts) };
}

/** Apply set/remove edits to the opening tags named by each patch's source offsets. */
export function applyTemplate(src: string, patches: Patch[]): { out: string; failed: { patch: Patch; reason: string }[] } {
  const tags = new Map(tokenize(src).map((t) => [t.start, t]));
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const failed: { patch: Patch; reason: string }[] = [];
  const edits: { start: number; end: number; text: string }[] = [];
  const merged = new Map<number, Patch>();
  for (const p of patches) {
    if (!p.src) continue;
    const prev = merged.get(p.src.start);
    merged.set(p.src.start, prev ? { ...prev, set: { ...prev.set, ...p.set }, removeAttrs: [...(prev.removeAttrs ?? []), ...(p.removeAttrs ?? [])] } : p);
  }
  for (const p of merged.values()) {
    const t = tags.get(p.src!.start);
    if (!t) { failed.push({ patch: p, reason: 'tag not found at the scanned position' }); continue; }
    let added = '';
    for (const [name, value] of Object.entries(p.set ?? {})) {
      const a = attr(t, name);
      if (a) edits.push({ start: a.start, end: a.end, text: `${a.name}="${esc(value)}"` });
      else added += ` ${name}="${esc(value)}"`;
    }
    const gone = new Set<Attr>();
    for (const name of p.removeAttrs ?? []) {
      const a = attr(t, name); if (!a || gone.has(a)) continue;
      gone.add(a);
      let s = a.start; while (/\s/.test(src[s - 1])) s--;
      edits.push({ start: s, end: a.end, text: '' });
    }
    if (added) {
      let pos = t.end - (t.selfClosing ? 2 : 1);
      while (/\s/.test(src[pos - 1])) pos--;
      edits.push({ start: pos, end: pos, text: added });
    }
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { out, failed };
}
