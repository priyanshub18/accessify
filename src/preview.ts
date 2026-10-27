import type { Fix, Issue } from './types.ts';
import { SourceFile } from './source.ts';
import { applyTemplate, tokenize } from './templates.ts';

export interface Snippet {
  line: number;
  before: string;
  after: string;
  css?: string;
  color?: { prop: string; from: string; to: string; fg?: string; bg?: string; ratio?: number };
}

const flat = (s: string, n = 320) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const cache = new WeakMap<object, Snippet | null>();
const parsed = new Map<string, SourceFile>();
/** Big sites have hundreds of fixes per file: parse each file once, not once per fix. */
function parse(text: string) {
  let sf = parsed.get(text);
  if (!sf) { sf = new SourceFile(text); parsed.set(text, sf); if (parsed.size > 8) parsed.delete(parsed.keys().next().value!); }
  return sf;
}
const MINI = new Set(['img', 'a', 'button', 'input', 'select', 'textarea', 'iframe', 'div', 'span', 'p', 'li', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'nav', 'td', 'font', 'b', 'i', 'small', 'svg']);

/** The exact source line before and after a fix, so the dashboard can show it changing. */
export function previewFix(i: Issue, fix: Fix, baseText: string): Snippet | undefined {
  const p = fix.patch;
  if (!p) return undefined;
  if (cache.has(p)) return cache.get(p) ?? undefined;
  let snip: Snippet | null = null;
  try {
    if (i.src) {
      const t0 = tokenize(baseText).find((t) => t.start === i.src!.start);
      const { out } = applyTemplate(baseText, [p]);
      const t1 = t0 && tokenize(out).find((t) => t.name === t0.name && t.ordinal === t0.ordinal);
      if (t0 && t1) snip = { line: i.src.line, before: flat(baseText.slice(t0.start, t0.end)), after: flat(out.slice(t1.start, t1.end)) };
    } else {
      const sf = parse(baseText);
      const el = sf.find(p.path);
      const st = el?.sourceCodeLocation?.startTag;
      if (el && st) {
        const before = baseText.slice(st.startOffset, st.endOffset);
        if (p.headInsert && !p.set && !p.addClass && !p.removeAttrs) {
          snip = { line: st.startLine, before: '<head> … (nothing here yet)', after: p.headInsert };
        } else {
          let after = flat(before);
          if (MINI.has(p.tag) && !/^<(td|tr|th)\b/i.test(before)) {
            // re-parse just this start tag instead of the whole page
            const wrap = `<!DOCTYPE html><html><head></head><body>${before}`;
            const mini = new SourceFile(wrap);
            const { out } = mini.apply([{ ...p, path: [1, 0], headInsert: undefined, cssRule: undefined, src: undefined }]);
            const e2 = new SourceFile(out).find([1, 0])?.sourceCodeLocation?.startTag;
            if (e2) after = flat(out.slice(e2.startOffset, e2.endOffset));
          } else {
            const { out } = sf.apply([p]);
            const st2 = new SourceFile(out).find(p.path)?.sourceCodeLocation?.startTag;
            if (st2) after = flat(out.slice(st2.startOffset, st2.endOffset));
          }
          snip = { line: st.startLine, before: flat(before), after };
        }
        if (p.cssRule) snip.css = p.cssRule;
        if (fix.edit?.kind === 'color') {
          const d = i.data ?? {};
          snip.color = { prop: fix.edit.prop ?? 'color', from: String(fix.edit.prop === 'color' ? d.fgColor : d.bgColor ?? ''), to: fix.edit.value, fg: d.fgColor, bg: d.bgColor, ratio: Number(d.contrastRatio) || undefined };
        }
      }
    }
  } catch { snip = null; }
  cache.set(p, snip);
  return snip ?? undefined;
}
