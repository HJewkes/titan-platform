import { isRecommendedLabel } from "./outcome.js";

/**
 * Reading the human's answers out of an `AskUserQuestion` tool result, ported from
 * active-work's `src/precedent/parse-answer.ts`.
 *
 * The result is prose: `The user answered: "<q>"="<a>", "<q2>"="<a2>". ...`
 * (older builds say `Your questions have been answered:`). An answer may
 * itself contain quotes, so a quote only closes it when followed by `, "` or
 * `. `, which is the separator the harness writes.
 */

const PAIR = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.|"(?!,\s*"|\.\s))*)"/g;
const REJECTED = "doesn't want to proceed";

export interface ParsedAnswers {
  /** The owner declined the question; such a call is unscored. */
  rejected: boolean;
  answers: Map<string, string>;
}

function unescape(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

/** A JSON result carrying `{answers: {question: answer}}`, the structured form some builds emit. */
function jsonAnswers(text: string): Map<string, string> | null {
  if (!text.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text) as { answers?: unknown };
    if (typeof parsed.answers !== "object" || parsed.answers === null) return null;
    const entries = Object.entries(parsed.answers as Record<string, unknown>);
    return new Map(entries.map(([q, a]) => [q, String(a)]));
  } catch {
    return null;
  }
}

export function parseAnswerText(text: string): ParsedAnswers {
  const structured = jsonAnswers(text);
  if (structured) return { rejected: false, answers: structured };
  const answers = new Map<string, string>();
  for (const match of text.matchAll(PAIR)) {
    answers.set(unescape(match[1] ?? ""), unescape(match[2] ?? ""));
  }
  return { rejected: text.includes(REJECTED), answers };
}

/** Exact question first; the harness truncates long questions, so fall back to a 40-char prefix. */
export function answerFor(answers: ReadonlyMap<string, string>, question: string): string | null {
  const exact = answers.get(question);
  if (exact !== undefined) return exact;
  const prefix = question.slice(0, 40);
  for (const [q, a] of answers) if (q.slice(0, 40) === prefix) return a;
  return null;
}

/** The first option whose label carries a recommendation marker, as the asker wrote it. */
export function recommendedOption(options: readonly string[]): string | null {
  return options.find(isRecommendedLabel) ?? null;
}
