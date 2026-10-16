import { detectGitToplevel, hasNoCommits, runGitLargeResult, type GitLargeResult, type HistoryLoad } from "./git.js";
import { canonicalize, rebasePath } from "./log.js";
import { revArgs, sinceArgs } from "./window.js";

/** Task ids such as `TP-2474` or `CC-44`, read from commit subjects. */
export const DEFAULT_TASK_ID_PATTERN = /\b[A-Z][A-Z0-9]*-\d+\b/g;

/** One `-U0` hunk: `oldCount` lines at `oldStart` became `newCount` lines at `newStart`. */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** A commit's edit to one file, with its hunks' new-side lines already carried forward to HEAD. */
export interface FileEdit {
  commit: string;
  epoch: number;
  taskIds: readonly string[];
  /** Repo-relative path at HEAD (after later renames), rebased onto the caller's root. */
  filePath: string;
  /** Inclusive 1-based line ranges in HEAD coordinates. */
  ranges: readonly [number, number][];
}

export interface LoadFileEditsOptions {
  repoRoot: string;
  windowDays: number;
  rev?: string;
  untilEpoch?: number;
  taskIdPattern?: RegExp;
}

interface RawFileDiff {
  oldPath: string | null;
  newPath: string | null;
  renamed: boolean;
  hunks: Hunk[];
}

interface RawCommit {
  commit: string;
  epoch: number;
  subject: string;
  files: RawFileDiff[];
}

const COMMIT_MARK = "\u0001";
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Every in-window commit's per-file edits, newest first, with line ranges expressed against HEAD. */
export function loadFileEditsResult(options: LoadFileEditsOptions): HistoryLoad<FileEdit[]> {
  const gitRoot = detectGitToplevel(options.repoRoot);
  if (gitRoot === null) return { ok: false, reason: "not-git", detail: `${options.repoRoot} is not a git checkout` };
  if (options.rev === undefined && hasNoCommits(options.repoRoot)) return { ok: true, value: [] };
  const log = runPatchLog(options);
  if (!log.ok) return log;
  const canonicalRoot = canonicalize(options.repoRoot);
  const pattern = options.taskIdPattern ?? DEFAULT_TASK_ID_PATTERN;
  const value = carryToHead(parsePatchLog(log.out), pattern).flatMap((edit) => {
    const rel = rebasePath(edit.filePath, gitRoot, canonicalRoot);
    return rel === null ? [] : [{ ...edit, filePath: rel }];
  });
  return { ok: true, value };
}

/** Distinct task ids in a subject, in first-seen order. */
export function taskIdsIn(subject: string, pattern: RegExp): string[] {
  const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  return [...new Set(subject.match(global) ?? [])];
}

/** Commits from `git log -p -U0`, newest first, each with its files' paths and hunks. */
export function parsePatchLog(text: string): RawCommit[] {
  const commits: RawCommit[] = [];
  let file: RawFileDiff | null = null;
  let pendingContent = 0;
  for (const line of text.split("\n")) {
    if (pendingContent > 0 && (line.startsWith("+") || line.startsWith("-"))) {
      pendingContent--;
      continue;
    }
    // git's "\ No newline at end of file" sits between a hunk's content lines.
    if (pendingContent > 0 && line.startsWith("\\")) continue;
    pendingContent = 0;
    if (line.startsWith(COMMIT_MARK)) {
      const [commit = "", epoch = "0", ...subject] = line.slice(1).split("\t");
      commits.push({ commit, epoch: Number(epoch), subject: subject.join("\t"), files: [] });
      file = null;
    } else if (line.startsWith("diff --git ")) {
      file = { oldPath: null, newPath: null, renamed: false, hunks: [] };
      commits.at(-1)?.files.push(file);
    } else if (file) {
      pendingContent = readFileLine(file, line);
    }
  }
  return commits;
}

/** Apply one header or hunk line to `file`; returns how many content lines the hunk carries. */
function readFileLine(file: RawFileDiff, line: string): number {
  if (line.startsWith("rename from ") || line.startsWith("copy from ")) file.oldPath = line.replace(/^\w+ from /, "");
  else if (line.startsWith("rename to ") || line.startsWith("copy to ")) file.newPath = line.replace(/^\w+ to /, "");
  else if (line.startsWith("--- ")) file.oldPath = stripPrefix(line.slice(4), "a/");
  else if (line.startsWith("+++ ")) file.newPath = stripPrefix(line.slice(4), "b/");
  if (line.startsWith("rename to ")) file.renamed = true;
  const m = HUNK_RE.exec(line);
  if (!m) return 0;
  const hunk = { oldStart: Number(m[1]), oldCount: Number(m[2] ?? 1), newStart: Number(m[3]), newCount: Number(m[4] ?? 1) };
  file.hunks.push(hunk);
  return hunk.oldCount + hunk.newCount;
}

function stripPrefix(p: string, prefix: string): string | null {
  if (p === "/dev/null") return null;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * Walk newest to oldest, carrying each commit's new-side lines forward through every later commit's
 * hunks on the same file (following renames), so all edits land in HEAD's line numbering.
 */
export function carryToHead(commits: readonly RawCommit[], pattern: RegExp): FileEdit[] {
  const laterHunks = new Map<string, Hunk[][]>();
  const headPathOf = new Map<string, string>();
  const out: FileEdit[] = [];
  for (const c of commits) {
    const taskIds = taskIdsIn(c.subject, pattern);
    for (const f of c.files) {
      if (f.newPath === null) continue;
      const headPath = headPathOf.get(f.newPath) ?? f.newPath;
      const later = laterHunks.get(headPath) ?? [];
      const ranges = f.hunks.map((h) => carryRange(newSideRange(h), later));
      if (ranges.length > 0) out.push({ commit: c.commit, epoch: c.epoch, taskIds, filePath: headPath, ranges });
      laterHunks.set(headPath, [f.hunks, ...later]);
      if (f.renamed && f.oldPath !== null) headPathOf.set(f.oldPath, headPath);
    }
  }
  return out;
}

/** A pure deletion has no new-side lines; it sits at the line before the gap. */
function newSideRange(h: Hunk): [number, number] {
  if (h.newCount === 0) return [Math.max(1, h.newStart), Math.max(1, h.newStart)];
  return [h.newStart, h.newStart + h.newCount - 1];
}

/** `later` is ordered oldest first: the commit right after this one comes first. */
function carryRange(range: [number, number], later: readonly Hunk[][]): [number, number] {
  let [start, end] = range;
  for (const hunks of later) {
    start = carryLine(start, hunks);
    end = Math.max(start, carryLine(end, hunks));
  }
  return [start, end];
}

/** Where an old-side line ends up after one commit's `-U0` hunks; a rewritten line maps to its replacement's start. */
export function carryLine(line: number, hunks: readonly Hunk[]): number {
  let shift = 0;
  for (const h of hunks) {
    const lastOld = h.oldCount === 0 ? h.oldStart : h.oldStart + h.oldCount - 1;
    if (line < h.oldStart || (h.oldCount === 0 && line === h.oldStart)) break;
    if (line > lastOld) {
      shift += h.newCount - h.oldCount;
      continue;
    }
    return Math.max(1, h.newStart);
  }
  return line + shift;
}

function runPatchLog(options: LoadFileEditsOptions): GitLargeResult {
  const format = `--pretty=format:${COMMIT_MARK}%H%x09%ct%x09%s`;
  const args = [
    "log", ...sinceArgs(options.windowDays, options.untilEpoch), "--no-merges", "--no-color", "--no-ext-diff",
    "-p", "-U0", "-M", "-C", "--src-prefix=a/", "--dst-prefix=b/", format, ...revArgs(options.rev),
  ];
  return runGitLargeResult(options.repoRoot, args, 256 * 1024 * 1024);
}

/** A symbol's HEAD line span, for attributing edits. */
export interface SymbolSpan {
  id: string;
  startLine: number;
  endLine: number;
}

/** Distinct task ids and commits that edited one symbol. */
export interface SymbolAccretion {
  taskIds: Set<string>;
  commits: Set<string>;
}

/**
 * Credit each edit to the innermost symbols its ranges overlap, so a method edit counts for the
 * method and not again for its class. Keyed by symbol id; symbols nobody edited are absent.
 */
export function accreteSymbols(
  edits: readonly FileEdit[],
  spansByFile: ReadonlyMap<string, readonly SymbolSpan[]>,
): Map<string, SymbolAccretion> {
  const out = new Map<string, SymbolAccretion>();
  for (const edit of edits) {
    const spans = spansByFile.get(edit.filePath);
    if (!spans) continue;
    for (const range of edit.ranges) {
      for (const id of innermostOverlapping(spans, range)) {
        const acc = out.get(id) ?? { taskIds: new Set<string>(), commits: new Set<string>() };
        acc.commits.add(edit.commit);
        for (const t of edit.taskIds) acc.taskIds.add(t);
        out.set(id, acc);
      }
    }
  }
  return out;
}

function innermostOverlapping(spans: readonly SymbolSpan[], [start, end]: [number, number]): string[] {
  const hits = spans.filter((s) => s.startLine <= end && s.endLine >= start);
  const size = (s: SymbolSpan) => s.endLine - s.startLine;
  const encloses = (outer: SymbolSpan, inner: SymbolSpan) =>
    size(outer) > size(inner) && outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
  return hits.filter((s) => !hits.some((other) => encloses(s, other))).map((s) => s.id);
}
