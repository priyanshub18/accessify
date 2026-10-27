import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { Patch } from './types.ts';

type El = DefaultTreeAdapterMap['element'];
interface Edit { start: number; end: number; text: string }

const isEl = (n: any): n is El => n && typeof n.tagName === 'string';
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** An HTML file parsed with source offsets, so fixes land as minimal in-place edits. */
export class SourceFile {
  src: string;
  doc: ReturnType<typeof parse>;

  constructor(src: string) {
    this.src = src;
    this.doc = parse(src, { sourceCodeLocationInfo: true });
  }

  /** Same walk the browser scan uses: indices among element children, starting at <html>. */
  find(path: number[]): El | null {
    let node: El | undefined = this.doc.childNodes.find(isEl);
    for (const i of path) {
      if (!node) return null;
      node = node.childNodes.filter(isEl)[i];
    }
    return node ?? null;
  }

  private findTag(name: string, within: El | null): El | null {
    const walk = (n: El): El | null => {
      for (const c of n.childNodes.filter(isEl)) {
        if (c.tagName === name) return c;
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    return within ? walk(within) : null;
  }

  private insertPoint(el: El): number {
    const st = el.sourceCodeLocation!.startTag!;
    let pos = st.endOffset - 1;
    if (this.src[pos - 1] === '/') pos--;
    while (/\s/.test(this.src[pos - 1])) pos--;
    return pos;
  }

  private elementEdits(el: El, p: Patch): Edit[] {
    const loc = el.sourceCodeLocation;
    if (!loc?.startTag) throw new Error(`<${el.tagName}> has no explicit start tag in the source`);
    const edits: Edit[] = [];
    const attrs = loc.attrs ?? {};
    let added = '';
    const set = { ...(p.set ?? {}) };
    if (p.addClass) {
      const cur = el.attrs.find((a) => a.name === 'class')?.value ?? '';
      const merged = [...new Set([...cur.split(/\s+/).filter(Boolean), ...p.addClass.split(/\s+/)])].join(' ');
      set.class = merged;
    }
    for (const [name, value] of Object.entries(set)) {
      const a = attrs[name];
      if (a) edits.push({ start: a.startOffset, end: a.endOffset, text: `${name}="${esc(value)}"` });
      else added += ` ${name}="${esc(value)}"`;
    }
    for (const name of p.removeAttrs ?? []) {
      const a = attrs[name];
      if (!a) continue;
      let s = a.startOffset;
      while (/\s/.test(this.src[s - 1])) s--;
      edits.push({ start: s, end: a.endOffset, text: '' });
    }
    if (added) {
      const pos = this.insertPoint(el);
      edits.push({ start: pos, end: pos, text: added });
    }
    return edits;
  }

  /** Apply all patches for this file. Returns the new source and what could not be applied. */
  apply(patches: Patch[]): { out: string; failed: { patch: Patch; reason: string }[] } {
    const edits: Edit[] = [];
    const failed: { patch: Patch; reason: string }[] = [];
    const byEl = new Map<string, Patch>();
    const headLines: string[] = [];
    const css = new Set<string>();

    for (const p of patches) {
      if (p.headInsert) headLines.push(p.headInsert);
      if (p.cssRule) css.add(p.cssRule);
      if (!p.set && !p.addClass && !p.removeAttrs) continue;
      const k = p.path.join('.');
      const prev = byEl.get(k);
      byEl.set(k, prev ? {
        ...prev,
        set: { ...p.set, ...prev.set },
        addClass: [prev.addClass, p.addClass].filter(Boolean).join(' ') || undefined,
        removeAttrs: [...(prev.removeAttrs ?? []), ...(p.removeAttrs ?? [])],
      } : p);
    }

    for (const p of byEl.values()) {
      const el = this.find(p.path);
      if (!el) { failed.push({ patch: p, reason: 'element not found in source' }); continue; }
      if (el.tagName !== p.tag) { failed.push({ patch: p, reason: `source has <${el.tagName}>, scan saw <${p.tag}>` }); continue; }
      try { edits.push(...this.elementEdits(el, p)); }
      catch (e: any) { failed.push({ patch: p, reason: e.message }); }
    }

    const head = this.findTag('head', this.doc.childNodes.find(isEl) ?? null);
    const ours = head ? head.childNodes.filter(isEl).find((c) => c.tagName === 'style' && c.attrs.some((a) => a.name === 'data-accessify')) : null;
    if (css.size) {
      const rules = [...css].map((r) => `    ${r}`).join('\n');
      if (ours?.sourceCodeLocation?.endTag) {
        const at = ours.sourceCodeLocation.endTag.startOffset;
        edits.push({ start: at, end: at, text: `${rules}\n  ` });
      } else headLines.push(`<style data-accessify>\n${rules}\n  </style>`);
    }
    if (headLines.length) {
      const at = head?.sourceCodeLocation?.endTag?.startOffset;
      if (at == null) failed.push(...patches.filter((p) => p.headInsert).map((patch) => ({ patch, reason: '<head> has no closing tag to insert before' })));
      else edits.push({ start: at, end: at, text: headLines.map((l) => `  ${l}\n`).join('') + '' });
    }

    edits.sort((a, b) => a.start - b.start || a.end - b.end);
    let out = '', cur = 0;
    for (const e of edits) {
      if (e.start < cur) { failed.push({ patch: patches[0], reason: 'overlapping edits' }); continue; }
      out += this.src.slice(cur, e.start) + e.text;
      cur = e.end;
    }
    return { out: out + this.src.slice(cur), failed };
  }
}
