export type RGB = [number, number, number];

export function parseColor(s: string | null | undefined): RGB | null {
  if (!s) return null;
  s = s.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)) as RGB;
  m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB;
  m = s.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

export const toHex = (c: RGB) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

export function luminance([r, g, b]: RGB): number {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Move `fg` along lightness (hue and saturation kept) until it clears `target` against `bg`. */
export function shiftToContrast(fg: RGB, bg: RGB, target: number): RGB | null {
  const [h, s, l] = rgbToHsl(fg);
  const dirs = luminance(bg) > 0.4 ? [-1, 1] : [1, -1];
  for (const d of dirs) {
    for (let step = 0; step <= 100; step++) {
      const nl = l + (d * step) / 100;
      if (nl < 0 || nl > 1) break;
      const c = hslToRgb(h, s, nl);
      if (contrast(c, bg) >= target) return c;
    }
  }
  return null;
}

export interface ColorFix {
  prop: 'color' | 'background-color';
  value: string;
  ratio: number;
  note: string;
}

/**
 * Pick the smallest brand-preserving change that clears the required ratio.
 * White/black text sitting on an element's own coloured background keeps its text and
 * darkens the background instead; everything else keeps its background and shifts the text.
 * `attempt > 1` falls back to plain black or white text.
 */
export function fixContrast(fgS: string, bgS: string, required: number, ownBgS: string | null, attempt = 1): ColorFix | null {
  const fg = parseColor(fgS), bg = parseColor(bgS);
  if (!fg || !bg) return null;
  const target = required + (attempt > 1 ? 0.6 : 0.15);
  const [, fs, fl] = rgbToHsl(fg);
  const ownBg = parseColor(ownBgS);
  const ownsBg = !!ownBg && toHex(ownBg) === toHex(bg);
  const neutralExtreme = fs < 0.12 && (fl > 0.9 || fl < 0.1);

  const viaFg = (): ColorFix | null => {
    const c = attempt > 1 ? null : shiftToContrast(fg, bg, target);
    const out = c ?? (contrast([0, 0, 0], bg) >= contrast([255, 255, 255], bg) ? ([0, 0, 0] as RGB) : ([255, 255, 255] as RGB));
    return { prop: 'color', value: toHex(out), ratio: contrast(out, bg), note: `text ${toHex(fg)} → ${toHex(out)}` };
  };
  const viaBg = (): ColorFix | null => {
    if (!ownsBg || attempt > 1) return null;
    const c = shiftToContrast(bg, fg, target);
    return c ? { prop: 'background-color', value: toHex(c), ratio: contrast(fg, c), note: `background ${toHex(bg)} → ${toHex(c)}` } : null;
  };
  return (neutralExtreme ? viaBg() ?? viaFg() : viaFg());
}
