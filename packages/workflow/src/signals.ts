export type SignalMatcher = (output: string) => boolean;

/** Invisible in rendered markdown, unambiguous to parse: `<!-- signal: needs_revision -->`. */
const CANONICAL_MARKER = /<!--\s*signal:\s*([a-z_]+)\s*-->/i;

/**
 * Verdict conventions brain's review and planning prompts converged on. They
 * are a fallback for prose; the canonical marker always wins.
 */
export const DEFAULT_SIGNAL_PATTERNS: Record<string, SignalMatcher> = {
  needs_revision: (c) => /##\s*Verdict:\s*NEEDS\s+REVISION/i.test(c) || /verdict:\s*\*{0,2}NEEDS\s+REVISION\*{0,2}/i.test(c),
  has_open_questions: (c) => {
    const match = c.match(/##\s*Open\s+Questions\s*\n([\s\S]*?)(?=\n##\s|\n$|$)/i);
    const section = match?.[1]?.trim() ?? "";
    return section.length > 0 && section !== "(none)" && section !== "None";
  },
  approved: (c) => /Verdict:\s*(?:PASS|READY)\b/i.test(c) || /\*{2}(?:PASS|READY)\*{2}/.test(c),
  needs_fixes: (c) => /Verdict:\s*NEEDS\s+WORK/i.test(c) || /##\s*FIX\s+Items\s*\n(?!\s*None)/i.test(c),
  changes_requested: (c) => /changes\s+requested/i.test(c),
  needs_clarification: (c) => /needs?\s+clarification/i.test(c),
  high_risk: (c) => {
    const risk = c.match(/Risk\s*(?:Score|Level)?\s*:\s*(\d+)/i);
    return risk ? Number.parseInt(risk[1]!, 10) >= 4 : false;
  },
  needs_changes: (c) => /needs?\s+changes/i.test(c) || /##\s*Verdict:\s*ITERATE/i.test(c),
};

export type SignalParser = (output: string | undefined) => string | null;

/**
 * Canonical marker first (the agent's stated intent), then the prose patterns
 * in registration order. Unknown marker names fall through to the patterns.
 */
export function createSignalParser(patterns: Record<string, SignalMatcher> = DEFAULT_SIGNAL_PATTERNS): SignalParser {
  return (output) => {
    if (!output) return null;
    const marker = output.match(CANONICAL_MARKER)?.[1]?.toLowerCase();
    if (marker && marker in patterns) return marker;
    for (const [name, matches] of Object.entries(patterns)) if (matches(output)) return name;
    return null;
  };
}

export const parseSignal: SignalParser = createSignalParser();
