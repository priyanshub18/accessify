import type { Fix, Issue } from './types.ts';
import { fixContrast } from './color.ts';
import { describeImage, llmOn, nameElement, suggestTitle } from './llm.ts';

/** Rules this agent can repair on its own. Everything else is reported for a human. */
export const FIXABLE = new Set([
  'html-has-lang', 'document-title', 'image-alt', 'button-name', 'link-name', 'input-button-name',
  'label', 'select-name', 'color-contrast', 'meta-viewport', 'tabindex', 'link-in-text-block', 'frame-title',
]);

const words = (s: string) => s.replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const ABBR: Record<string, string> = { freq: 'Frequency', qty: 'Quantity', addr: 'Address', ph: 'Phone', pwd: 'Password', msg: 'Message', num: 'Number', dob: 'Date of birth', q: 'Search' };
const ICONS: [RegExp, string][] = [
  [/M21 21l-4\.3-4\.3|search|magnif/i, 'Search'], [/M6 6h15|cart|basket|\bbag\b/i, 'Shopping cart'],
  [/M3 12h18|hamburger|\bmenu\b/i, 'Menu'], [/M18 6L6 18|\bclose\b|dismiss/i, 'Close'],
  [/instagram|facebook|twitter|linkedin|youtube|github/i, ''],
];
const generic = new Set(['icon', 'btn', 'button', 'link', 'social', 'tools', 'nav', 'item']);

function heuristicName(i: Issue): string | null {
  const a = i.ctx.attrs;
  for (const v of [a.title, i.ctx.prevLabel, a.placeholder, a.value]) if (v?.trim()) return cap(v.trim());
  if (a.name && ABBR[a.name.toLowerCase()]) return ABBR[a.name.toLowerCase()];
  if (a.name || a.id) return cap(words(a.name || a.id).toLowerCase());
  if (i.ctx.inLink || a.href) {
    const href = a.href || i.ctx.inLink || '';
    const host = href.match(/^https?:\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1];
    if (host) return cap(host);
  }
  const hay = i.ctx.html + ' ' + (a.class ?? '');
  for (const [re, name] of ICONS) if (re.test(hay)) return name || null;
  const cls = words(a.class ?? '').split(' ').filter((w) => w && !generic.has(w.toLowerCase()));
  return cls.length ? cap(cls.join(' ')) : null;
}

const humanFile = (f: string) => cap(words(f.replace(/\.[a-z]+$/i, '').split('/').pop() ?? f));

export async function planFix(i: Issue, attempt: number, pageTitle: string): Promise<Fix> {
  const fix = await plan(i, attempt, pageTitle);
  if (i.src && fix.patch) fix.patch.src = { start: i.src.start, end: i.src.end };
  return fix;
}

async function plan(i: Issue, attempt: number, pageTitle: string): Promise<Fix> {
  const manual = (note: string): Fix => ({ status: 'manual', description: note, method: 'heuristic', confidence: 0, note });
  const a = i.ctx.attrs;
  const live = llmOn();
  const tag = i.ctx.tag;

  switch (i.rule) {
    case 'html-has-lang':
      return { status: 'planned', method: 'deterministic', confidence: 0.9, description: 'Set lang="en" on <html>', edit: { kind: 'attr', attr: 'lang', label: 'Language code', value: 'en' }, patch: { path: i.path, tag, set: { lang: 'en' } } };

    case 'document-title': {
      const hf = humanFile(i.file);
      let t = pageTitle && pageTitle.toLowerCase() !== hf.toLowerCase() ? `${pageTitle} | ${hf}` : hf;
      let method: Fix['method'] = 'heuristic', conf = 0.7;
      if (live) {
        try { const g = await suggestTitle({ file: i.file, h1: pageTitle, text: i.ctx.parentText }); if (g) { t = g; method = 'llm'; conf = 0.85; } } catch { /* keep heuristic title */ }
      }
      return { status: 'planned', method, confidence: conf, description: `Add <title>${t}</title>`, edit: { kind: 'title', label: 'Page title', value: t }, patch: { path: i.path, tag, headInsert: `<title>${escHtml(t)}</title>` } };
    }

    case 'image-alt': {
      const src = a.src ?? '';
      const file = src.split('/').pop() ?? src;
      const altFix = (alt: string, method: Fix['method'], confidence: number, description: string): Fix => ({
        status: 'planned', method, confidence, description,
        edit: { kind: 'attr', attr: 'alt', label: 'Alt text (empty = decorative)', value: alt }, patch: { path: i.path, tag, set: { alt } },
      });
      if (live && i.imageB64) {
        try {
          const r = await describeImage(i.imageB64, { mime: i.imageMime, src: file, nearby: i.ctx.parentText, page: pageTitle, inLink: i.ctx.inLink });
          if (r.decorative || !r.alt) return altFix('', 'vision', 0.9, 'Mark as decorative (alt="")');
          return altFix(r.alt, 'vision', 0.9, `alt="${r.alt}"`);
        } catch { /* Gemini unavailable: fall through to the markup heuristics */ }
      }
      if (/divider|spacer|separator|decor|ornament|background|pattern|\bbg\b/i.test(file)) return altFix('', 'heuristic', 0.75, 'Mark as decorative (alt="") from file name');
      if (/\bsrc\s*=\s*\{/.test(i.ctx.html)) return manual('The image source is an import or expression, so there is no file name to go on. Write the alt text by hand.');
      const alt = cap(words(file.replace(/\.[a-z0-9]+$/i, '')));
      return alt
        ? altFix(alt, 'heuristic', 0.45, `alt="${alt}" (from file name; edit it or let Gemini describe it)`)
        : manual('no usable hint for alt text');
    }

    case 'button-name': case 'link-name': case 'input-button-name': case 'label': case 'select-name': case 'frame-title': {
      if (i.rule === 'frame-title') {
        const host = (a.src ?? '').match(/^https?:\/\/(?:www\.)?([^/]+)/)?.[1];
        return host ? { status: 'planned', method: 'heuristic', confidence: 0.5, description: `title="${cap(host)} embed"`, edit: { kind: 'attr', attr: 'title', label: 'Frame title', value: `${cap(host)} embed` }, patch: { path: i.path, tag, set: { title: `${cap(host)} embed` } } } : manual('cannot infer iframe purpose');
      }
      let name: string | null = null, method: Fix['method'] = 'heuristic', conf = 0.65;
      if (live) {
        try {
          name = await nameElement({ mime: i.imageMime, tag, html: i.ctx.html, text: i.ctx.text, parentText: i.ctx.parentText, page: pageTitle, imageB64: i.imageB64 });
          method = i.imageB64 ? 'vision' : 'llm'; conf = 0.9;
        } catch { name = null; }
      }
      name ??= heuristicName(i);
      if (!name) return manual('could not infer a name; needs a human label');
      return { status: 'planned', method, confidence: conf, description: `aria-label="${name}"`, edit: { kind: 'attr', attr: 'aria-label', label: 'Accessible name', value: name }, patch: { path: i.path, tag, set: { 'aria-label': name } } };
    }

    case 'color-contrast': {
      const d = i.data;
      if (!d?.fgColor || !d?.bgColor) return manual('background is an image or gradient; pick colours by hand');
      const need = parseFloat(String(d.expectedContrastRatio)) || 4.5;
      const f = fixContrast(d.fgColor, d.bgColor, need, i.ctx.ownBg, attempt);
      if (!f) return manual('could not parse colours');
      const cls = `a11y-${f.prop === 'color' ? 'text' : 'bg'}-${f.value.slice(1)}`;
      return {
        status: 'planned', method: 'deterministic', confidence: 0.85,
        edit: { kind: 'color', prop: f.prop, label: `New ${f.prop === 'color' ? 'text' : 'background'} colour (hex)`, value: f.value },
        description: `${f.note} (contrast ${Number(d.contrastRatio).toFixed(2)} → ${f.ratio.toFixed(2)}, needs ${need})`,
        patch: { path: i.path, tag, addClass: cls, cssRule: `.${cls} { ${f.prop}: ${f.value} !important; }` },
      };
    }

    case 'link-in-text-block':
      return { status: 'planned', method: 'deterministic', confidence: 0.9, description: 'Underline the link so it is not distinguished by colour alone', patch: { path: i.path, tag, addClass: 'a11y-underline', cssRule: '.a11y-underline { text-decoration: underline !important; }' } };

    case 'meta-viewport': {
      const c = (a.content ?? '').replace(/,?\s*(maximum-scale|user-scalable)\s*=\s*[^,]*/gi, '').replace(/^\s*,\s*/, '');
      return { status: 'planned', method: 'deterministic', confidence: 0.95, description: `viewport → "${c}" (allow pinch zoom)`, patch: { path: i.path, tag, set: { content: c } } };
    }

    case 'tabindex': {
      const native = ['a', 'button', 'input', 'select', 'textarea'].includes(tag);
      return native
        ? { status: 'planned', method: 'deterministic', confidence: 0.9, description: `Remove tabindex="${a.tabindex}" so focus follows document order`, patch: { path: i.path, tag, removeAttrs: ['tabindex', 'tabIndex'] } }
        : { status: 'planned', method: 'deterministic', confidence: 0.8, description: 'Set tabindex="0" (natural tab order)', patch: { path: i.path, tag, set: { tabindex: '0' } } };
    }

    default:
      return manual(`${i.help} (needs human judgement)`);
  }
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Rebuild a fix around a value the reviewer typed. Throws a readable error if the value is not acceptable. */
export function applyEdit(fix: Fix, value: string): Fix {
  const e = fix.edit, p = fix.patch;
  if (!e || !p) throw new Error('this fix cannot be edited');
  const v = value.trim();
  if (/[\r\n]/.test(value) || v.length > 300) throw new Error(`${e.label}: one line, 300 characters at most`);
  const base: Fix = { ...fix, method: 'human', confidence: 1, edit: { ...e, value: v } };
  if (e.kind === 'attr') {
    if (e.attr === 'lang' && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(v)) throw new Error('Language code looks like "en" or "pt-BR"');
    if (e.attr !== 'alt' && !v) throw new Error(`${e.label} cannot be empty`);
    return { ...base, description: e.attr === 'alt' && !v ? 'Mark as decorative (alt="")' : `${e.attr}="${v}"`, patch: { ...p, set: { [e.attr!]: v } } };
  }
  if (e.kind === 'title') {
    if (!v) throw new Error('Page title cannot be empty');
    return { ...base, description: `Add <title>${v}</title>`, patch: { ...p, headInsert: `<title>${escHtml(v)}</title>` } };
  }
  if (!/^#[0-9a-f]{6}$/i.test(v)) throw new Error('Colour must be a 6-digit hex like #1a5fb4');
  const cls = `a11y-${e.prop === 'color' ? 'text' : 'bg'}-${v.slice(1).toLowerCase()}`;
  return { ...base, description: `Set ${e.prop} to ${v.toLowerCase()}`, patch: { ...p, addClass: cls, cssRule: `.${cls} { ${e.prop}: ${v.toLowerCase()} !important; }` } };
}
