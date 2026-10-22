export interface DiffFile {
  path: string;
  /** The old path of a rename. */
  from?: string;
  status: "A" | "M" | "D" | "R";
  added: string[];
  removed: number;
}

function headerLine(file: DiffFile, line: string): void {
  if (line.startsWith("new file mode")) file.status = "A";
  else if (line.startsWith("deleted file mode")) file.status = "D";
  else if (line.startsWith("rename from ")) [file.status, file.from] = ["R", line.slice("rename from ".length)];
  else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
  else if (line.startsWith("+++ b/")) file.path = line.slice("+++ b/".length);
}

/** The header's `b/` path; a deletion keeps it, and `+++` and `rename to` lines replace it. */
function startFile(line: string): DiffFile {
  const split = line.indexOf(" b/");
  return { path: split === -1 ? "" : line.slice(split + 3), status: "M", added: [], removed: 0 };
}

/** Parses `git diff --no-color --unified=0 -M base head`; pure, so a host and a fixture feed it the same text. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = startFile(line);
      files.push(file);
      inHunk = false;
    } else if (!file) continue;
    else if (line.startsWith("@@")) inHunk = true;
    else if (!inHunk) headerLine(file, line);
    else if (line.startsWith("+")) file.added.push(line.slice(1));
    else if (line.startsWith("-")) file.removed += 1;
  }
  return files;
}
