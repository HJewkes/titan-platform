import { CI_POLICY_KEYS, refusedLines, visibleLines, type CiPolicy } from "@titan-design/session-read";

type CiPolicyRefusal = "ci_policy_prose" | "ci_policy_malformed";

const CI_POLICY_UNCHANGED_LINE = "CI-policy: unchanged";
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])\s+/;
const BOLD = /^(?:(?:[-*+]|\d{1,9}[.)])\s+)?(?:\*\*|__)/;
const SENTENCE_END = /[.!]$/;
const MIN_SENTENCE_WORDS = 4;
/** `weaken`, not `weakened`: any form of the word in prose may be a weakening the reviewer did not put on the canonical line. */
const DANGER_WORDS = ["weaken", ...CI_POLICY_KEYS.map(fold)];

function fold(line: string): string {
  return line.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A heading or a sentence that happens to start with the label, as opposed to a second attempt at the line itself. */
function isProse(line: string): boolean {
  if (LIST_MARKER.test(line) || BOLD.test(line)) return true;
  return SENTENCE_END.test(line) && line.split(/\s+/).length >= MIN_SENTENCE_WORDS;
}

const readsDanger = (line: string): boolean => DANGER_WORDS.some((word) => fold(line).includes(word));

/**
 * The CI-policy a MERGE carries, or why it is refused (TP-4391). The parser reads every labelled line and a prose heading
 * beside a correct block makes it `malformed`; that is taken as `unchanged` only when Head+1 holds the exact unchanged
 * line and every other labelled line is prose naming neither a weakening nor a key. A weakened reading is the parser's
 * and never reaches here. A refusal where every other labelled line is prose is `ci_policy_prose`, kept apart so the
 * prose cases can be counted.
 */
export function mergeCiPolicy(ciPolicy: CiPolicy | undefined, text: string, lineOffset: number): CiPolicy | undefined | CiPolicyRefusal {
  if (ciPolicy?.kind !== "malformed") return ciPolicy;
  const others = refusedLines(text, "ci_policy_malformed");
  if (others.length === 0 || !others.every(isProse)) return "ci_policy_malformed";
  const canonical = visibleLines(text)[lineOffset + 3] === CI_POLICY_UNCHANGED_LINE;
  return canonical && !others.some(readsDanger) ? { kind: "unchanged" } : "ci_policy_prose";
}
