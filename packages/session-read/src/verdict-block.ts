/**
 * The three-line reviewer block (TP-520): `Verdict: MERGE|FIX_FIRST`, `PR: owner/name#n`,
 * `Head: <40 lowercase hex>`. It gates merges, so text that may be someone else's only ever
 * makes it stricter. Rules, all per line and in one pass:
 * - A line is read only when indented 0 to 3 spaces (a tab counts 4); an indented-code line
 *   is never a block line. Trailing whitespace and CRLF are harmless.
 * - A quoted line ("> Verdict: MERGE") keeps its marker and never matches.
 * - A fence opens on ``` or ~~~ (3 or more) and closes only on a bare line of the same
 *   character at least as long, as in CommonMark. An unclosed fence hides the rest.
 * - An HTML comment hides every line that starts inside it, until a line holding `-->`.
 * - Any visible line starting `Verdict:` is a block start, so a second one is refused, even
 *   when identical or malformed. A `Status:` line is ignored.
 */

export type VerdictBlockVerdict = "MERGE" | "FIX_FIRST";

export type VerdictBlockRefusal =
  | "no_block"
  | "multiple_blocks"
  | "bad_verdict"
  | "missing_pr_line"
  | "bad_pr"
  | "missing_head_line"
  | "bad_head";

export type VerdictBlockResult =
  | { ok: true; verdict: VerdictBlockVerdict; repo: string; pr: number; head: string; lineOffset: number }
  | { ok: false; reason: VerdictBlockRefusal };

const PR_LINE = /^PR: ([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]{0,15})$/;
const HEAD_LINE = /^Head: ([0-9a-f]{40})$/;
const FENCE = /^(`{3,}|~{3,})/;

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
      if (line.includes("-->")) inComment = false;
      return null;
    }
    const opener = indentOf(raw) < 4 ? FENCE.exec(line) : null;
    if (opener) {
      fence = { char: opener[1]![0]!, length: opener[1]!.length };
      return null;
    }
    inComment = line.lastIndexOf("<!--") > line.lastIndexOf("-->");
    return indentOf(raw) < 4 ? line : null;
  });
}

function closesFence(raw: string, line: string, fence: { char: string; length: number }): boolean {
  if (indentOf(raw) >= 4 || line.length < fence.length) return false;
  return line[0] === fence.char && [...line].every((c) => c === fence.char);
}

function indentOf(raw: string): number {
  let width = 0;
  for (const char of raw) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
}

function readBlock(lines: (string | null)[], at: number): VerdictBlockResult {
  const verdict = lines[at] ?? "";
  if (verdict !== "Verdict: MERGE" && verdict !== "Verdict: FIX_FIRST") return { ok: false, reason: "bad_verdict" };
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
  return {
    ok: true,
    verdict: verdict === "Verdict: MERGE" ? "MERGE" : "FIX_FIRST",
    repo: `${pr[1]}/${pr[2]}`,
    pr: number,
    head: head[1]!,
    lineOffset: at,
  };
}

function isDotName(name: string): boolean {
  return name === "." || name === "..";
}
