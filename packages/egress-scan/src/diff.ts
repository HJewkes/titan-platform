export interface AddedLine {
  readonly line: number;
  readonly text: string;
}

export interface DiffFile {
  readonly path: string;
  /** 1-based position in its diff, used in place of a path that itself trips a rule. */
  readonly ordinal: number;
  /** True for a new, renamed or copied file, whose path is itself new text. */
  readonly pathAdded: boolean;
  readonly binary: boolean;
  readonly lines: readonly AddedLine[];
}

/** One unit of scanned text: a diff, or a commit's message plus its diff. */
export interface ScanSource {
  readonly sha?: string;
  readonly message?: readonly string[];
  readonly files: readonly DiffFile[];
  readonly binaryFiles: number;
}

interface MutableFile {
  path: string;
  ordinal: number;
  pathAdded: boolean;
  binary: boolean;
  lines: AddedLine[];
}

interface Hunk {
  columns: number;
  newLine: number;
  remainingNew: number;
  remainingOld: number[];
}

const HUNK_HEADER = /^(@{2,}) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? \1/;
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** Undoes git's C-style path quoting (`core.quotePath`), octal UTF-8 bytes included. */
export function unquotePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? "";
    const next = body[i + 1] ?? "";
    if (char !== "\\") bytes.push(...new TextEncoder().encode(char));
    else if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripSide(path: string): string {
  return path.replace(/^[ab]\//, "");
}

function headerPath(header: string): string {
  const combined = /^diff --(?:cc|combined) (.+)$/.exec(header);
  if (combined) return unquotePath(combined[1] ?? "");
  const rest = header.slice("diff --git ".length);
  const quoted = / ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted) return stripSide(unquotePath(quoted[1] ?? ""));
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(2, half);
  return stripSide(rest.slice(rest.lastIndexOf(" b/") + 1));
}

function rangeCount(token: string): number {
  const count = token.split(",")[1];
  return count === undefined ? 1 : Number(count);
}

function parseHunkHeader(line: string): Hunk | undefined {
  const match = HUNK_HEADER.exec(line);
  if (!match) return undefined;
  const oldRanges = (match[2] ?? "").trim().split(" ");
  return {
    columns: (match[1] ?? "").length - 1,
    newLine: Number(match[3]),
    remainingNew: match[4] === undefined ? 1 : Number(match[4]),
    remainingOld: oldRanges.map(rangeCount),
  };
}

function isHunkLine(hunk: Hunk, line: string): boolean {
  if (line.startsWith("\\")) return true;
  return line.length >= hunk.columns && /^[ +-]*$/.test(line.slice(0, hunk.columns));
}

/** Applies one hunk body line; a `-` in any column means the line is not in the new file. */
function consumeHunkLine(hunk: Hunk, line: string, file: MutableFile): void {
  if (line.startsWith("\\")) return;
  const marks = [...line.slice(0, hunk.columns)];
  const removed = marks.includes("-");
  const oldMark = removed ? "-" : " ";
  hunk.remainingOld = hunk.remainingOld.map((n, i) => (marks[i] === oldMark ? n - 1 : n));
  if (removed) return;
  if (marks.includes("+")) file.lines.push({ line: hunk.newLine, text: line.slice(hunk.columns) });
  hunk.newLine++;
  hunk.remainingNew--;
}

function hunkDone(hunk: Hunk): boolean {
  return hunk.remainingNew <= 0 && hunk.remainingOld.every((n) => n <= 0);
}

function applyHeaderLine(line: string, file: MutableFile): Hunk | undefined {
  if (file.binary) return undefined;
  const renamed = /^(?:rename|copy) to (.+)$/.exec(line);
  if (line.startsWith("new file mode ")) file.pathAdded = true;
  else if (renamed) {
    file.path = unquotePath(renamed[1] ?? "");
    file.pathAdded = true;
  } else if (line.startsWith("+++ ")) {
    const target = line.slice(4).replace(/\t$/, "");
    if (target !== "/dev/null") file.path = stripSide(unquotePath(target));
  } else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
  else if (line.startsWith("@@")) return parseHunkHeader(line);
  return undefined;
}

function mergeInto(target: MutableFile, file: DiffFile): void {
  target.pathAdded ||= file.pathAdded;
  target.binary ||= file.binary;
  const seen = new Set(target.lines.map((l) => `${l.line}\n${l.text}`));
  target.lines.push(...file.lines.filter((l) => !seen.has(`${l.line}\n${l.text}`)));
}

/** Folds the per-parent diffs of one merge into one entry per path, so a line is reported once. */
function mergeSamePaths(files: readonly DiffFile[]): DiffFile[] {
  const byPath = new Map<string, MutableFile>();
  for (const file of files) {
    const target = byPath.get(file.path);
    if (target) mergeInto(target, file);
    else byPath.set(file.path, { ...file, ordinal: byPath.size + 1, lines: [...file.lines] });
  }
  return [...byPath.values()];
}

/**
 * Parses `git diff -U0` or `git show -U0` patch text into the added lines of each file, with
 * new-file line numbers. Removed lines are dropped; binary files are kept for their path only.
 * A merge shown with `--diff-merges=separate` names a path once per parent; those fold into one.
 */
export function parseDiff(text: string): ScanSource {
  const files: MutableFile[] = [];
  let hunk: Hunk | undefined;
  for (const line of text.split("\n")) {
    const file = files.at(-1);
    if (hunk && file && isHunkLine(hunk, line)) {
      consumeHunkLine(hunk, line, file);
      if (hunkDone(hunk)) hunk = undefined;
      continue;
    }
    hunk = undefined;
    if (/^diff --(?:git|cc|combined) /.test(line)) {
      files.push({ path: headerPath(line), ordinal: files.length + 1, pathAdded: false, binary: false, lines: [] });
    } else if (file) hunk = applyHeaderLine(line, file);
  }
  const merged = mergeSamePaths(files);
  return { files: merged, binaryFiles: merged.filter((f) => f.binary).length };
}

/** Parses `git show -U0 --format=%B%x00 <sha>` output: the message, a NUL, then the patch. */
export function parseCommit(sha: string, text: string): ScanSource {
  const cut = text.indexOf("\0");
  if (cut < 0) throw new Error(`commit ${sha.slice(0, 7)}: no NUL after the message`);
  const message = text.slice(0, cut).replace(/\n+$/, "").split("\n");
  return { ...parseDiff(text.slice(cut + 1)), sha, message };
}
