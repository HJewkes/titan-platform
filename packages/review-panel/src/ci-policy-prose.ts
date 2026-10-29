import { refusedLines, visibleLines, type CiPolicy } from "@titan-design/session-read";

type CiPolicyRefusal = "ci_policy_prose" | "ci_policy_malformed";

const CI_POLICY_UNCHANGED_LINE = "CI-policy: unchanged";
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])\s+/;
const BOLD = /^(?:(?:[-*+]|\d{1,9}[.)])\s+)?(?:\*\*|__)/;
const SENTENCE_END = /[.!]$/;
const MIN_SENTENCE_WORDS = 4;
/** Accepted by allowlist, not refused by danger words: a weakening has more wordings than any list can name (TP-4391). */
const HARMLESS_RESTS = new Set(["unchanged", "nofilesundergithubchanged", "nogithubfileschanged", "nogithubfileschange", "nothingundergithubchanged"]);
const LEADING_LABEL = /^\d*cipolicy/;

/** Keeps non-ASCII letters, so a homoglyph cannot fold a word into an allowed one by vanishing. */
function fold(line: string): string {
  return line.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** A heading or a sentence that happens to start with the label, as opposed to a second attempt at the line itself. */
function isProse(line: string): boolean {
  if (LIST_MARKER.test(line) || BOLD.test(line)) return true;
  return SENTENCE_END.test(line) && line.split(/\s+/).length >= MIN_SENTENCE_WORDS;
}

const saysUnchanged = (line: string): boolean => HARMLESS_RESTS.has(fold(line).replace(LEADING_LABEL, ""));

/**
 * The CI-policy a MERGE carries, or why it is refused (TP-4391). The parser reads every labelled line and a prose heading
 * beside a correct block makes it `malformed`; that is taken as `unchanged` only when Head+1 holds the exact unchanged
 * line and every other labelled line is prose whose rest is on the `HARMLESS_RESTS` allowlist. A weakened reading is the parser's
 * and never reaches here. A refusal where every other labelled line is prose is `ci_policy_prose`, kept apart so the
 * prose cases can be counted.
 */
export function mergeCiPolicy(ciPolicy: CiPolicy | undefined, text: string, lineOffset: number): CiPolicy | undefined | CiPolicyRefusal {
  if (ciPolicy?.kind !== "malformed") return ciPolicy;
  const others = refusedLines(text, "ci_policy_malformed");
  if (others.length === 0 || !others.every(isProse)) return "ci_policy_malformed";
  const canonical = visibleLines(text)[lineOffset + 3] === CI_POLICY_UNCHANGED_LINE;
  return canonical && others.every(saysUnchanged) ? { kind: "unchanged" } : "ci_policy_prose";
}
