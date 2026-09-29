/**
 * The three-line reviewer block (TP-520): `Verdict: MERGE|FIX_FIRST`, `PR: owner/name#n`,
 * `Head: <40 lowercase hex>`. It gates merges, so every doubt is a refusal. Rules:
 * each line is trimmed on both sides (an indented block counts, CRLF is harmless), while a
 * quoted line ("> Verdict: MERGE") keeps its marker and never matches; lines inside a
 * ``` or ~~~ fence are skipped; any line starting `Verdict:` outside a fence is a block
 * start, so a second one is refused even when identical or malformed. A `Status:` line
 * anywhere is ignored. One pass over the lines, and each line is matched on its own.
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
const FENCE = /^(```|~~~)/;

/** Reads the one Verdict/PR/Head block in `text`; `lineOffset` is the zero-based line of its Verdict line. */
export function parseVerdictBlock(text: string): VerdictBlockResult {
  const lines = text.split("\n").map((line) => line.trim());
  const starts = verdictStarts(lines);
  if (starts.length === 0) return { ok: false, reason: "no_block" };
  if (starts.length > 1) return { ok: false, reason: "multiple_blocks" };
  return readBlock(lines, starts[0]!);
}

function verdictStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced && line.startsWith("Verdict:")) starts.push(index);
  });
  return starts;
}

function readBlock(lines: string[], at: number): VerdictBlockResult {
  const verdict = lines[at];
  if (verdict !== "Verdict: MERGE" && verdict !== "Verdict: FIX_FIRST") return { ok: false, reason: "bad_verdict" };
  const prLine = lines[at + 1];
  if (prLine === undefined || !prLine.startsWith("PR:")) return { ok: false, reason: "missing_pr_line" };
  const pr = PR_LINE.exec(prLine);
  const number = pr ? Number(pr[3]) : NaN;
  if (!pr || !Number.isSafeInteger(number) || isDotName(pr[1]!) || isDotName(pr[2]!) || pr[2]!.endsWith(".git")) {
    return { ok: false, reason: "bad_pr" };
  }
  const headLine = lines[at + 2];
  if (headLine === undefined || !headLine.startsWith("Head:")) return { ok: false, reason: "missing_head_line" };
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
