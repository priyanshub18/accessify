import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceFile } from '../src/source.ts';
import { contrast, fixContrast, parseColor } from '../src/color.ts';
import { spoken } from '../src/scan.ts';
import { scorePage } from '../src/score.ts';
import { applyTemplate, scanTemplate, tokenize } from '../src/templates.ts';

const page = `<!DOCTYPE html>
<html>
<head><title>T</title></head>
<body>
  <img class="a" src="x.png">
  <img src="y.png" />
  <button tabindex="3">Go</button>
  <p class="lead" style="color:red">hi</p>
</body>
</html>`;

// html > body (index 1) > children
const p = (i: number) => [1, i];

test('adds attributes in place without touching the rest', () => {
  const { out, failed } = new SourceFile(page).apply([
    { path: p(0), tag: 'img', set: { alt: 'A "cup"' } },
    { path: p(1), tag: 'img', set: { alt: '' } },
  ]);
  assert.equal(failed.length, 0);
  assert.match(out, /<img class="a" src="x.png" alt="A &quot;cup&quot;">/);
  assert.match(out, /<img src="y.png" alt="" \/>/);
  assert.equal(out.replace(/ alt="[^"]*"/g, ''), page);
});

test('merges classes and removes attributes', () => {
  const { out } = new SourceFile(page).apply([
    { path: p(3), tag: 'p', addClass: 'a11y-x' },
    { path: p(3), tag: 'p', addClass: 'a11y-y' },
    { path: p(2), tag: 'button', removeAttrs: ['tabindex'] },
  ]);
  assert.match(out, /<p class="lead a11y-x a11y-y" style/);
  assert.match(out, /<button>Go<\/button>/);
});

test('refuses to edit when the scanned tag does not match the source', () => {
  const { out, failed } = new SourceFile(page).apply([{ path: p(0), tag: 'button', set: { 'aria-label': 'x' } }]);
  assert.equal(failed.length, 1);
  assert.equal(out, page);
});

test('creates one style block and reuses it on the next round', () => {
  const r1 = new SourceFile(page).apply([{ path: p(3), tag: 'p', addClass: 'c1', cssRule: '.c1 { color: #111 !important; }' }]).out;
  assert.equal(r1.match(/<style data-accessify>/g)?.length, 1);
  const r2 = new SourceFile(r1).apply([{ path: p(3), tag: 'p', addClass: 'c2', cssRule: '.c2 { color: #222 !important; }' }]).out;
  assert.equal(r2.match(/<style data-accessify>/g)?.length, 1);
  assert.match(r2, /\.c1[\s\S]*\.c2/);
});

test('contrast fixes reach the required ratio and keep hue', () => {
  const f = fixContrast('#a8a8a8', '#fdf6ec', 4.5, null)!;
  assert.equal(f.prop, 'color');
  assert.ok(contrast(parseColor(f.value)!, parseColor('#fdf6ec')!) >= 4.5);
  const orange = fixContrast('#e0b36a', '#ffffff', 4.5, null)!;
  const [r, g, b] = parseColor(orange.value)!;
  assert.ok(r > g && g > b, 'still an orange/brown');
});

test('white text on its own coloured background darkens the background instead', () => {
  const f = fixContrast('#ffffff', '#e8a33d', 4.5, '#e8a33d')!;
  assert.equal(f.prop, 'background-color');
  assert.ok(f.ratio >= 4.5);
});

test('retry attempt falls back to plain black or white text', () => {
  const f = fixContrast('#a8a8a8', '#ffffff', 4.5, null, 2)!;
  assert.ok(['#000000', '#ffffff'].includes(f.value));
});

test('screen reader transcript flags unnamed controls but ignores icons inside named buttons', () => {
  const t = spoken(`- button "Search":\n  - img\n- button:\n  - img\n- link "Home":\n  - /url: index.html`);
  assert.deepEqual(t.map((x) => [x.text, x.warn]), [['button, Search', false], ['button, unlabeled', true], ['link, Home', false]]);
});

test('score rises as violations fall', () => {
  const bad = scorePage(20, [{ impact: 'critical', nodes: 4 }, { impact: 'serious', nodes: 9 }]);
  const good = scorePage(20, []);
  assert.ok(bad < 60 && good === 100);
});

const jsx = `export const A = () => (
  <main>
    <img src="/a.png" />
    <button onClick={go}><svg /></button>
    <button tabIndex={2}>Save</button>
    <input placeholder="Email" />
    <label htmlFor="q">Q</label><input id="q" />
    {list.map((x) => <a href={x.u}>{x.t}</a>)}
  </main>
);
const n: Array<string> = [];`;

test('template scan finds the usual JSX problems and ignores named controls', () => {
  const rules = scanTemplate('/nonexistent', 'A.jsx', jsx).issues.map((i) => i.rule).sort();
  assert.deepEqual(rules, ['button-name', 'image-alt', 'label', 'tabindex']);
});

test('template edits are minimal, handle JSX attributes and fix what they target', () => {
  const scan = scanTemplate('/nonexistent', 'A.jsx', jsx);
  const patches = scan.issues.map((i) => ({
    path: [], tag: i.ctx.tag, src: i.src!,
    ...(i.rule === 'tabindex' ? { removeAttrs: ['tabindex', 'tabIndex'] } : { set: { [i.rule === 'image-alt' ? 'alt' : 'aria-label']: 'X' } }),
  }));
  const { out, failed } = applyTemplate(jsx, patches);
  assert.equal(failed.length, 0);
  assert.match(out, /<img src="\/a.png" alt="X" \/>/);
  assert.match(out, /<button>Save<\/button>/);
  assert.match(out, /<button onClick=\{go\} aria-label="X">/);
  assert.equal(scanTemplate('/nonexistent', 'A.jsx', out).issues.length, 0);
});

test('tokenizer survives generics and counts real tags', () => {
  assert.equal(tokenize('const a: Array<string> = []; /* <img> */ <img src="x" />').filter((t) => t.name === 'img').length, 2);
});
