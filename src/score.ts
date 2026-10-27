const IMPACT: Record<string, number> = { critical: 10, serious: 7, moderate: 4, minor: 2 };

/** Lighthouse-style: passing rules count 3 each, failing rules cost impact × (1 + 0.25 × nodes, capped). */
export function scorePage(passes: number, violations: { impact: string | null; nodes: number }[]): number {
  const good = passes * 3;
  const bad = violations.reduce((s, v) => s + (IMPACT[v.impact ?? 'minor'] ?? 2) * (1 + 0.25 * Math.min(v.nodes, 8)), 0);
  return Math.round((100 * good) / (good + bad || 1));
}
