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
 * - Any visible line starting `Verdict:` is a block start, so a second one is refused, even
 *   when identical or malformed. A `Status:` line is ignored.
 */

export type VerdictBlockVerdict = "MERGE" | "FIX_FIRST";

type VerdictBlockCloser = "yes" | "no";

export type VerdictBlockRefusal =
  | "no_block"
  | "multiple_blocks"
  | "bad_verdict"
  | "missing_pr_line"
  | "bad_pr"
  | "missing_head_line"
  | "bad_head";

export type VerdictBlockResult =
  | { ok: true; verdict: VerdictBlockVerdict; repo: string; pr: number; head: string; lineOffset: number; closer?: VerdictBlockCloser }
  | { ok: false; reason: "wait"; repo: string; pr: number; head: string; lineOffset: number }
  | { ok: false; reason: VerdictBlockRefusal };

const PR_LINE = /^PR: ([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]{0,15})$/;
const HEAD_LINE = /^Head: ([0-9a-f]{40})$/;
const CLOSER_LINE = /^Closer: (yes|no)$/;
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
  return readBlock(lines, starts[0]!);
}

/** One entry per line: its trimmed text, or null when fenced, commented out or indented as code. */
function visibleLines(text: string): (string | null)[] {
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

function readBlock(lines: (string | null)[], at: number): VerdictBlockResult {
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
  if (verdict === "Verdict: MERGE") return { ok: true, verdict: "MERGE", ...named };
  const closer = readCloser(lines, at + 3);
  return { ok: true, verdict: "FIX_FIRST", ...named, ...(closer && { closer }) };
}

/** Any second visible Closer line voids the answer: a duplicate is never read. */
function readCloser(lines: (string | null)[], at: number): VerdictBlockCloser | undefined {
  const match = CLOSER_LINE.exec(lines[at] ?? "");
  const duplicated = lines.some((line, index) => index !== at && line?.startsWith("Closer:"));
  if (!match || duplicated) return undefined;
  return match[1] as VerdictBlockCloser;
}

function isDotName(name: string): boolean {
  return name === "." || name === "..";
}
