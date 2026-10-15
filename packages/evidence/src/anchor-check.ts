import { parseAnchor, type Anchor, type AnchorPins } from "./anchor.js";
import { verifyRange, type CitationRejection, type LineRange } from "./citation.js";
import type { LineSource } from "./line-source.js";

/** File text at one commit, for each pinned commit an anchor may name. */
export type RevisionSource = (rev: string) => LineSource;

export type AnchorCheck =
  | { ok: true; anchor: Anchor; first: string; last: string }
  | { ok: false; reason: CitationRejection | "bad-anchor"; detail: string };

interface PinnedRange {
  rev: string;
  range: LineRange;
}

/** A diff anchor spanning both sides checks each endpoint as one line at its own commit. */
function pinnedRanges(anchor: Anchor): PinnedRange[] {
  if (anchor.side !== "diff") return [{ rev: anchor.rev, range: anchor }];
  const { path, start, end } = anchor;
  if (start.side === end.side) return [{ rev: start.rev, range: { path, lineStart: start.line, lineEnd: end.line } }];
  return [start, end].map((point) => ({ rev: point.rev, range: { path, lineStart: point.line, lineEnd: point.line } }));
}

function failure(reason: CitationRejection, detail: string, lines: LineSource, { rev, range }: PinnedRange): string {
  if (reason === "past-eof") return `past EOF (${lines.lines(range.path)?.length ?? 0} lines)`;
  if (reason === "path-unreadable") return `not a file at ${rev}`;
  return detail;
}

/**
 * Parses `text` against `pins`, then checks each line it names exists at its pinned commit.
 * A refusal's detail starts with the anchor text and names the file's line count when past EOF;
 * success quotes the first and last anchored lines back.
 */
export function verifyAnchorText(text: string, pins: AnchorPins, source: RevisionSource): AnchorCheck {
  const parsed = parseAnchor(text, pins);
  if (!parsed.ok) return { ok: false, reason: "bad-anchor", detail: `${text}: ${parsed.detail}` };
  const quoted: string[] = [];
  for (const pinned of pinnedRanges(parsed.anchor)) {
    const lines = source(pinned.rev);
    const check = verifyRange(lines, pinned.range);
    if (!check.ok) return { ok: false, reason: check.reason, detail: `${text}: ${failure(check.reason, check.detail, lines, pinned)}` };
    quoted.push(check.fileLines[pinned.range.lineStart - 1] ?? "", check.fileLines[pinned.range.lineEnd - 1] ?? "");
  }
  return { ok: true, anchor: parsed.anchor, first: quoted[0] ?? "", last: quoted.at(-1) ?? "" };
}
