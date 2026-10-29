/**
 * One changed file on the owner's evidence card, shown exactly or not at all (TP-4490). Whatever a rendering could lose (a
 * long line, a line ending, an undecodable byte, a mode-only change, a cap), the file reaches the card only when its rows,
 * as shown, rebuild the head bytes from the base bytes. No case is listed: each one fails that one invariant or shows whole.
 */
import type { RepoFile } from "@titan-design/github";
import { gitBlobId } from "../approved-set.js";
import { lineEdits } from "../shepherd/ci-policy-changes.js";
import { exactLine, unexactLine } from "./exact-line.js";

/** One changed line: `-` removed from the base, `+` added at the head, `n` its 1-based line number on that side, `text` through `exactLine` with its terminator kept. */
export interface ExactRow {
  side: "-" | "+";
  n: number;
  text: string;
}

export interface ExactFile {
  path: string;
  rows: ExactRow[];
}

/** The head blob the evidence pinned for this path: a sha, null for absent at head, undefined when the evidence pinned none. */
type HeadPin = string | null | undefined;

const decodesWhole = (file: RepoFile | null): boolean => file === null || gitBlobId(Buffer.from(file.content, "utf8")) === file.blobSha;

/** Lines split after each LF with the LF kept, so a CR, a missing final break or any other byte stays inside a line. */
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** The rows for `path` between `base` and `head` (null: absent on that side), at most `maxRows` of them, or why the file cannot show whole. */
export function exactFile(path: string, base: RepoFile | null, head: RepoFile | null, pin: HeadPin, maxRows: number): ExactFile | string {
  const shown = exactLine(path);
  if (!decodesWhole(base) || !decodesWhole(head)) return `${shown} does not decode to the bytes of its git blob`;
  if (pin !== undefined && (head?.blobSha ?? null) !== pin) return `${shown} at head is not the blob the merge evidence pinned`;
  if ((base?.blobSha ?? null) === (head?.blobSha ?? null)) return `${shown} is listed as changed, but its content did not change`;
  const sides = { "-": linesOf(base?.content ?? ""), "+": linesOf(head?.content ?? "") };
  const rows = lineEdits(sides["-"], sides["+"])
    .slice(0, maxRows)
    .map(({ side, index }) => ({ side, n: index + 1, text: exactLine(sides[side][index]!) }));
  if (rebuilt(sides["-"], rows) !== (head?.content ?? "")) return `${shown} changes more than the card can show`;
  return { path: shown, rows };
}

/** The head text the shown rows make of the base: removed lines dropped, added lines placed at their numbers, the rest kept in order. */
function rebuilt(base: readonly string[], rows: readonly ExactRow[]): string {
  const removed = new Set(rows.filter((row) => row.side === "-").map((row) => row.n));
  const kept = base.filter((_, index) => !removed.has(index + 1));
  const added = new Map(rows.filter((row) => row.side === "+").map((row) => [row.n, unexactLine(row.text)]));
  const lines: string[] = [];
  for (let n = 1, next = 0; n <= kept.length + added.size; n += 1) lines.push(added.get(n) ?? kept[next++] ?? "");
  return lines.join("");
}
