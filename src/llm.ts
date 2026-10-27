import { geminiBase, geminiKey, geminiModel, setAutoModel } from './settings.ts';

export const llmInfo = () => (geminiKey() ? { mode: 'gemini' as const, model: geminiModel() } : { mode: 'heuristic' as const, model: null });
export const llmOn = () => !!geminiKey();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ask(parts: any[], maxTokens = 1024): Promise<string> {
  const model = geminiModel();
  const generationConfig: any = { maxOutputTokens: maxTokens, temperature: 0.2, responseMimeType: 'application/json' };
  if (/gemini-2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${geminiBase()}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': geminiKey()!, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
      signal: AbortSignal.timeout(45_000),
    });
    if (r.status === 429 || r.status >= 500) { lastErr = `Gemini API ${r.status}`; await sleep(1500 * (attempt + 1) ** 2); continue; }
    if (!r.ok) throw new Error(`Gemini API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    if (!text) throw new Error(`Gemini returned no text (${j.candidates?.[0]?.finishReason ?? j.promptFeedback?.blockReason ?? 'unknown'})`);
    return text;
  }
  throw new Error(`${lastErr} after retries (rate limited?)`);
}

function json(text: string): any {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('model returned no JSON');
  return JSON.parse(m[0]);
}

const clean = (s: string, n = 125) => s.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim().slice(0, n);
const img = (b64: string, mime = 'image/png') => ({ inline_data: { mime_type: mime, data: b64 } });

/** Check a key and pick the newest Flash model it can use. */
export async function verifyGemini(key: string): Promise<{ ok: boolean; model?: string; error?: string }> {
  try {
    const r = await fetch(`${geminiBase()}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { ok: false, error: r.status === 400 || r.status === 403 ? 'Gemini rejected this key.' : `Gemini API ${r.status}` };
    const j: any = await r.json();
    const ver = (n: string) => parseFloat(n.match(/gemini-(\d+(?:\.\d+)?)-flash$/)?.[1] ?? '0');
    const best = (j.models ?? [])
      .filter((m: any) => /^models\/gemini-[\d.]+-flash$/.test(m.name) && m.supportedGenerationMethods?.includes('generateContent'))
      .sort((a: any, b: any) => ver(b.name) - ver(a.name))[0];
    if (best) setAutoModel(best.name.replace('models/', ''));
    return { ok: true, model: best?.name.replace('models/', '') };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

export async function describeImage(imageB64: string, c: { mime?: string; src: string; nearby: string; page: string; inLink: string | null }) {
  const out = json(await ask([
    img(imageB64, c.mime),
    { text:
      `Write alt text for this image on the web page "${c.page}".\nFile: ${c.src}\nNearby text: ${c.nearby || '(none)'}\n` +
      (c.inLink ? `The image is the only content of a link to ${c.inLink}, so describe where the link goes.\n` : '') +
      `Rules: describe what matters to a blind visitor in under 125 characters, no "image of", no trailing period needed. ` +
      `If it is purely decorative (dividers, backgrounds, ornaments) set decorative true.\n` +
      `Reply with JSON only: {"alt": "...", "decorative": false}` },
  ]));
  return { alt: clean(String(out.alt ?? '')), decorative: !!out.decorative };
}

export async function nameElement(c: { mime?: string; tag: string; html: string; text: string; parentText: string; page: string; imageB64?: string }) {
  const parts: any[] = [];
  if (c.imageB64) parts.push(img(c.imageB64, c.mime));
  parts.push({ text:
    `This <${c.tag}> on the page "${c.page}" has no accessible name. Give the short name a screen reader should announce ` +
    `(1-4 words, say what it does, do not include the role like "button").\nHTML: ${c.html}\nSurrounding text: ${c.parentText || '(none)'}\n` +
    `Reply with JSON only: {"name": "..."}` });
  return clean(String(json(await ask(parts)).name ?? ''), 80);
}

export async function suggestTitle(c: { file: string; h1: string; text: string }) {
  const out = json(await ask([{ text:
    `Write a concise, descriptive <title> (max 60 characters) for a web page.\nFile: ${c.file}\nMain heading: ${c.h1 || '(none)'}\nPage text excerpt: ${c.text.slice(0, 400) || '(none)'}\n` +
    `Put the page purpose first, the site name last, separated by " | ". Reply with JSON only: {"title": "..."}` }]));
  return clean(String(out.title ?? ''), 70);
}

/** One or two sentences telling a developer how to fix something the agent will not touch itself. */
export async function advise(c: { rule: string; help: string; html: string; page: string }) {
  const out = json(await ask([{ text:
    `An accessibility scan (axe-core rule "${c.rule}": ${c.help}) flagged this element on "${c.page}".\nHTML: ${c.html.slice(0, 400)}\n` +
    `In at most 2 short sentences, tell the developer what to change in the markup. Be specific. Reply with JSON only: {"advice": "..."}` }], 400));
  return clean(String(out.advice ?? ''), 300);
}
