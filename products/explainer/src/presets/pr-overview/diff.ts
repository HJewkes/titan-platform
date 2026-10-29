/** One hunk's line range on the head side; a pure deletion has no head lines and is kept with `headLines: 0`. */
export interface DiffHunk {
  headStart: number;
  headLines: number;
}

export interface DiffFile {
  /** The head path; a deleted file's is its base path, as git names both sides alike. */
  path: string;
  status: "added" | "deleted" | "renamed" | "modified";
  /** The base path of a rename. */
  from?: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

const HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function newFile(header: RegExpExecArray): DiffFile {
  return { path: header[2]!, status: "modified", additions: 0, deletions: 0, hunks: [] };
}

function readMeta(file: DiffFile, line: string): void {
  if (line.startsWith("new file mode")) file.status = "added";
  else if (line.startsWith("deleted file mode")) file.status = "deleted";
  else if (line.startsWith("rename from ")) {
    file.status = "renamed";
    file.from = line.slice("rename from ".length);
  }
}

function readLine(file: DiffFile, line: string, inHunk: boolean): boolean {
  const hunk = HUNK.exec(line);
  if (hunk) {
    file.hunks.push({ headStart: Number(hunk[1]), headLines: hunk[2] === undefined ? 1 : Number(hunk[2]) });
    return true;
  }
  if (!inHunk) readMeta(file, line);
  else if (line.startsWith("+")) file.additions += 1;
  else if (line.startsWith("-")) file.deletions += 1;
  return inHunk;
}

/** The files of a `git diff` / `gh pr diff` patch, in patch order. */
export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let inHunk = false;
  for (const line of patch.replace(/\r/g, "").split("\n")) {
    const header = HEADER.exec(line);
    if (header) {
      current = newFile(header);
      files.push(current);
      inHunk = false;
    } else if (current) {
      inHunk = readLine(current, line, inHunk);
    }
  }
  return files;
}
