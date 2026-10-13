/**
 * The three-line reviewer block (TP-520): `Verdict: MERGE|FIX_FIRST`, `PR: owner/name#n`,
 * `Head: <40 lowercase hex>`. It gates merges, so text that may be someone else's only ever
 * makes it stricter. Rules, all per line and in one pass:
 * - A line is read only when indented 0 to 3 spaces (a tab counts 4, and any other character
 *   `trim` strips, such as U+00A0, counts 1); an indented-code line is never a block line.
 *   Trailing whitespace and CRLF are harmless.
 * - A quoted line ("> Verdict: MERGE") keeps its marker and never matches.
 * - A fence opens on ``` or ~~~ (3 or more), also after list or `>` markers, and closes only
 *   on a bare line of the same character at least as long. An unclosed fence hides the rest.
 * - An HTML comment hides every line that starts inside it, until a line holding `-->` with
 *   no `<!--` after its last `-->`.
 * - `Verdict: WAIT` (required checks unfinished at the head) is read as a block too, but never as `ok`: it
 *   returns `{ ok: false, reason: "wait" }` with the PR and head it names, so no MERGE path can take it.
 * - An optional fourth line `Closer: yes|no` (is this head closer to MERGE than the last reviewed one) is read
 *   only directly after Head and only on FIX_FIRST. Absent, on MERGE or WAIT, or any other value, a duplicate, or
 *   a line anywhere else, it leaves `closer` undefined and the block parses as it would without it.
 * - An optional fourth line `CI-policy: unchanged` or `CI-policy: weakened <key>(, <key>)*` (TP-2407) is read only
 *   directly after Head and only on MERGE. Keys come from a closed set, each at most once. Unlike every other rule here,
 *   the label is looked for on every raw line, fenced, indented, commented out or not, and a line is labelled when it
 *   folds to `cipolicy...` (see `foldCiPolicyLine`: NFKC, lower case, every non-alphanumeric and any list number gone).
 *   With no labelled line `ciPolicy` is undefined. A labelled line whose rest folds to `weakened` and known keys reads
 *   weakened wherever it sits; the canonical unchanged line counts only as the one labelled line, exact and visible at
 *   Head+1; any other labelled line reads `{ kind: "malformed" }`. Across lines the strictest reading wins: weakened
 *   (keys merged) over malformed over unchanged. Both gate on any PR: a reviewer who wrote the line meant something.
 * - Any visible line starting `Verdict:` is a block start, so a second one is refused, even
 *   when identical or malformed. A `Status:` line is ignored.
 */

export type VerdictBlockVerdict = "MERGE" | "FIX_FIRST";

type VerdictBlockCloser = "yes" | "no";

export const CI_POLICY_KEYS = ["required-check", "permissions", "pull_request_target", "secrets", "ruleset", "other"] as const;

export type CiPolicyKey = (typeof CI_POLICY_KEYS)[number];

export type CiPolicy = { kind: "unchanged" } | { kind: "weakened"; keys: CiPolicyKey[] } | { kind: "malformed" };

export type VerdictBlockRefusal =
  | "no_block"
  | "multiple_blocks"
  | "bad_verdict"
  | "missing_pr_line"
  | "bad_pr"
  | "missing_head_line"
  | "bad_head";

export type VerdictBlockResult =
  | { ok: true; verdict: VerdictBlockVerdict; repo: string; pr: number; head: string; lineOffset: number; closer?: VerdictBlockCloser; ciPolicy?: CiPolicy }
  | { ok: false; reason: "wait"; repo: string; pr: number; head: string; lineOffset: number }
  | { ok: false; reason: VerdictBlockRefusal };

const PR_LINE = /^PR: ([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]{0,15})$/;
const HEAD_LINE = /^Head: ([0-9a-f]{40})$/;
const CLOSER_LINE = /^Closer: (yes|no)$/;
const CI_POLICY_UNCHANGED_LINE = "CI-policy: unchanged";
const CI_POLICY_LABEL = "cipolicy";
const CI_POLICY_WEAKENED = "weakened";
const NOT_ALPHANUMERIC = /[^a-z0-9]/g;
const LIST_NUMBER = /^[0-9]+/;
const FENCE = /^(`{3,}|~{3,})/;
const TRIMMED_SPACE = /[\s\uFEFF]/;
const CONTAINER = /^(?:>\s*|[-*+]\s+|\d{1,9}[.)]\s+)/;

/** Reads the one Verdict/PR/Head block in `text`; `lineOffset` is the zero-based line of its Verdict line. */
export function parseVerdictBlock(text: string): VerdictBlockResult {
  const lines = visibleLines(text);
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line?.startsWith("Verdict:")) starts.push(index);
  });
  if (starts.length === 0) return { ok: false, reason: "no_block" };
  if (starts.length > 1) return { ok: false, reason: "multiple_blocks" };
  return readBlock(text, lines, starts[0]!);
}

/** One entry per line: its trimmed text, or null when fenced, commented out or indented as code; shared so every reviewer-message parser agrees on what is visible. */
export function visibleLines(text: string): (string | null)[] {
  let fence: { char: string; length: number } | null = null;
  let inComment = false;
  return text.split("\n").map((raw) => {
    const line = raw.trim();
    if (fence) {
      if (closesFence(raw, line, fence)) fence = null;
      return null;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = line.indexOf("<!--", line.lastIndexOf("-->")) >= 0;
      return null;
    }
    const opener = indentOf(raw) < 4 ? FENCE.exec(stripContainers(line)) : null;
    if (opener) {
      fence = { char: opener[1]![0]!, length: opener[1]!.length };
      return null;
    }
    inComment = line.lastIndexOf("<!--") > line.lastIndexOf("-->");
    return indentOf(raw) < 4 ? line : null;
  });
}

/** Drops leading blockquote and list markers, so a fence opened inside a container is still seen. */
function stripContainers(line: string): string {
  let rest = line;
  for (let match = CONTAINER.exec(rest); match; match = CONTAINER.exec(rest)) rest = rest.slice(match[0].length);
  return rest;
}

function closesFence(raw: string, line: string, fence: { char: string; length: number }): boolean {
  if (indentOf(raw) >= 4 || line.length < fence.length) return false;
  return line[0] === fence.char && [...line].every((c) => c === fence.char);
}

function indentOf(raw: string): number {
  let width = 0;
  for (const char of raw) {
    if (char === "\t") width += 4;
    else if (TRIMMED_SPACE.test(char)) width += 1;
    else break;
  }
  return width;
}

function readBlock(text: string, lines: (string | null)[], at: number): VerdictBlockResult {
  const verdict = lines[at] ?? "";
  if (verdict !== "Verdict: MERGE" && verdict !== "Verdict: FIX_FIRST" && verdict !== "Verdict: WAIT") return { ok: false, reason: "bad_verdict" };
  const prLine = lines[at + 1];
  if (prLine == null || !prLine.startsWith("PR:")) return { ok: false, reason: "missing_pr_line" };
  const pr = PR_LINE.exec(prLine);
  const number = pr ? Number(pr[3]) : NaN;
  if (!pr || !Number.isSafeInteger(number) || isDotName(pr[1]!) || isDotName(pr[2]!) || pr[2]!.endsWith(".git")) {
    return { ok: false, reason: "bad_pr" };
  }
  const headLine = lines[at + 2];
  if (headLine == null || !headLine.startsWith("Head:")) return { ok: false, reason: "missing_head_line" };
  const head = HEAD_LINE.exec(headLine);
  if (!head) return { ok: false, reason: "bad_head" };
  const named = { repo: `${pr[1]}/${pr[2]}`, pr: number, head: head[1]!, lineOffset: at };
  if (verdict === "Verdict: WAIT") return { ok: false, reason: "wait", ...named };
  if (verdict === "Verdict: MERGE") {
    const ciPolicy = readCiPolicy(text, lines[at + 3] === CI_POLICY_UNCHANGED_LINE ? at + 3 : -1);
    return { ok: true, verdict: "MERGE", ...named, ...(ciPolicy && { ciPolicy }) };
  }
  const closer = readCloser(lines, at + 3);
  return { ok: true, verdict: "FIX_FIRST", ...named, ...(closer && { closer }) };
}

/** Any second visible Closer line voids the answer: a duplicate is never read. */
function readCloser(lines: (string | null)[], at: number): VerdictBlockCloser | undefined {
  const match = CLOSER_LINE.exec(lines[at] ?? "");
  const duplicated = lines.some((line, index) => index !== at && line?.startsWith("Closer:"));
  if (!match || duplicated) return undefined;
  return match[1] === "yes" ? "yes" : "no";
}

/**
 * Scans raw lines, not visible ones: a weakening written in a fence, a comment or an indent is still the reviewer's
 * word, and hiding it must never read as silence. `canonicalAt` is the Head+1 index when it holds the exact unchanged
 * line, else -1.
 */
function readCiPolicy(text: string, canonicalAt: number): CiPolicy | undefined {
  const readings = text.split("\n").flatMap((raw, index) => {
    const folded = foldCiPolicyLine(raw);
    if (!folded.startsWith(CI_POLICY_LABEL)) return [];
    return [readCiPolicyLabel(folded.slice(CI_POLICY_LABEL.length), index === canonicalAt)];
  });
  return readings.length === 0 ? undefined : strictestCiPolicy(readings);
}

/** Folds rather than matching a list of decorations, so a decoration no one listed still reads as labelled. */
function foldCiPolicyLine(raw: string): string {
  return raw.normalize("NFKC").toLowerCase().replace(NOT_ALPHANUMERIC, "").replace(LIST_NUMBER, "");
}

function readCiPolicyLabel(rest: string, canonicalUnchanged: boolean): CiPolicy {
  if (rest.startsWith(CI_POLICY_WEAKENED)) {
    const keys = foldedCiPolicyKeys(rest.slice(CI_POLICY_WEAKENED.length));
    return keys ? { kind: "weakened", keys } : { kind: "malformed" };
  }
  return canonicalUnchanged ? { kind: "unchanged" } : { kind: "malformed" };
}

/** Greedy is exact because no folded key is a prefix of another; an unknown, repeated or missing key reads undefined. */
function foldedCiPolicyKeys(rest: string): CiPolicyKey[] | undefined {
  const keys: CiPolicyKey[] = [];
  for (let remaining = rest; remaining.length > 0; ) {
    const key = CI_POLICY_KEYS.find((candidate) => remaining.startsWith(foldCiPolicyLine(candidate)));
    if (key === undefined || keys.includes(key)) return undefined;
    keys.push(key);
    remaining = remaining.slice(foldCiPolicyLine(key).length);
  }
  return keys.length > 0 ? keys : undefined;
}

function strictestCiPolicy(readings: CiPolicy[]): CiPolicy {
  const keys = [...new Set(readings.flatMap((reading) => (reading.kind === "weakened" ? reading.keys : [])))];
  if (keys.length > 0) return { kind: "weakened", keys };
  return readings.some((reading) => reading.kind === "malformed") ? { kind: "malformed" } : { kind: "unchanged" };
}

function isDotName(name: string): boolean {
  return name === "." || name === "..";
}
