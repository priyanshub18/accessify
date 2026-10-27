export interface NodeCtx {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  parentText: string;
  prevLabel: string;
  html: string;
  ownBg: string | null;
  inLink: string | null;
}

export interface Issue {
  key: string;
  file: string;
  rule: string;
  impact: string;
  help: string;
  helpUrl: string;
  selector: string;
  path: number[];
  html: string;
  data: any;
  ctx: NodeCtx;
  imageB64?: string;
  imageMime?: string;
  /** Page coordinates (CSS px) of the element, for pins on the screenshot. */
  rect?: { x: number; y: number; w: number; h: number };
  /** Present for template files (JSX, Vue, …) that are scanned statically instead of rendered. */
  src?: { start: number; end: number; line: number };
}

export interface PageScan {
  file: string;
  url: string;
  title: string;
  h1: string;
  passes: number;
  violations: { id: string; impact: string; nodes: number }[];
  issues: Issue[];
  score: number;
  shot: string;
  aria: string;
  size?: { w: number; h: number };
  static?: boolean;
}

export interface Patch {
  path: number[];
  /** Source offsets of the opening tag, for template files. */
  src?: { start: number; end: number };
  tag: string;
  set?: Record<string, string>;
  addClass?: string;
  removeAttrs?: string[];
  headInsert?: string;
  cssRule?: string;
}

/** What a reviewer can change before the PR: one value, validated by applyEdit(). */
export interface Editable {
  kind: 'attr' | 'title' | 'color';
  label: string;
  value: string;
  attr?: string;
  prop?: string;
}

export interface Fix {
  status: 'planned' | 'manual';
  description: string;
  method: 'deterministic' | 'vision' | 'llm' | 'heuristic' | 'human';
  edit?: Editable;
  confidence: number;
  patch?: Patch;
  note?: string;
}

export type Emit = (type: string, data?: Record<string, unknown>) => void;
