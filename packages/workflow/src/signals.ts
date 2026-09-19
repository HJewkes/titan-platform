export type SignalMatcher = (output: string) => boolean;

/** Invisible in rendered markdown, unambiguous to parse: `<!-- signal: needs_revision -->`. */
const CANONICAL_MARKER = /<!--\s*signal:\s*([a-z_]+)\s*-->/gi;

/** Reported for empty or whitespace-only output, so silence escalates to a human and never reads as approval. */
export const EMPTY_OUTPUT_SIGNAL = "empty_output";

/**
 * Verdict conventions brain's review and planning prompts converged on. They
 * are a fallback for prose; a canonical marker always wins. Key order is the
 * precedence order: `high_risk` escalates to a human, so it outranks every
 * verdict, and a risk score of 4 or more beats a PASS.
 */
export const DEFAULT_SIGNAL_PATTERNS: Record<string, SignalMatcher> = {
  high_risk: (c) => {
    const risk = c.match(/Risk\s*(?:Score|Level)?\s*:\s*(\d+)/i);
    return risk ? Number.parseInt(risk[1]!, 10) >= 4 : false;
  },
  needs_revision: (c) =>
    /##\s*Verdict:\s*NEEDS\s+REVISION/i.test(c) || /verdict:\s*\*{0,2}NEEDS\s+REVISION\*{0,2}/i.test(c) || /\*{2}NEEDS\s+REVISION\*{2}/.test(c),
  has_open_questions: (c) => {
    const match = c.match(/##\s*Open\s+Questions\s*\n([\s\S]*?)(?=\n##\s|\n$|$)/i);
    const section = match?.[1]?.trim() ?? "";
    return section.length > 0 && section !== "(none)" && section !== "None";
  },
  approved: (c) => /Verdict:\s*(?:PASS|READY)\b/i.test(c) || /\*{2}(?:PASS|READY)\*{2}/.test(c),
  needs_fixes: (c) =>
    /Verdict:\s*\*{0,2}NEEDS\s+WORK/i.test(c) || /\*{2}NEEDS\s+WORK\*{2}/.test(c) || /##\s*FIX\s+Items\s*\n(?!\s*None)/i.test(c),
  changes_requested: (c) => /changes\s+requested/i.test(c),
  needs_clarification: (c) => /needs?\s+clarification/i.test(c),
  needs_changes: (c) => /needs?\s+changes/i.test(c) || /##\s*Verdict:\s*ITERATE/i.test(c),
};

/** The highest-precedence signal, or null when nothing matches. */
export type SignalParser = (output: string | undefined) => string | null;

/** Every signal the output carries, highest precedence first. */
export type SignalSetParser = (output: string | undefined) => string[];

/**
 * Empty output yields only `EMPTY_OUTPUT_SIGNAL`. Otherwise canonical markers
 * naming a known pattern are authoritative and the prose is ignored; without
 * one, every matching prose pattern is reported. Both lists follow the key
 * order of `patterns`. Unknown marker names fall through to the prose.
 */
export function createSignalSetParser(patterns: Record<string, SignalMatcher> = DEFAULT_SIGNAL_PATTERNS): SignalSetParser {
  const names = Object.keys(patterns);
  return (output) => {
    if (!output?.trim()) return [EMPTY_OUTPUT_SIGNAL];
    const marked = markedSignals(output);
    const declared = names.filter((name) => marked.has(name));
    if (declared.length > 0) return declared;
    return names.filter((name) => patterns[name]!(output));
  };
}

/** The first entry of `createSignalSetParser(patterns)`, so the same precedence decides. */
export function createSignalParser(patterns: Record<string, SignalMatcher> = DEFAULT_SIGNAL_PATTERNS): SignalParser {
  const parseAll = createSignalSetParser(patterns);
  return (output) => parseAll(output)[0] ?? null;
}

function markedSignals(output: string): Set<string> {
  return new Set([...output.matchAll(CANONICAL_MARKER)].map((match) => match[1]!.toLowerCase()));
}

export const parseSignals: SignalSetParser = createSignalSetParser();
export const parseSignal: SignalParser = createSignalParser();
