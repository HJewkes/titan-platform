/** A function from a shell snapshot: its body text, or unreadable when its end is cut off or ambiguous. */
export type SnapshotFunction = { body: string } | { unreadable: true };

/** Function name to definition, as the shell would hold it after sourcing the snapshot. */
export type FunctionTable = ReadonlyMap<string, SnapshotFunction>;

const SECTION = "# Functions";
const UNREADABLE: SnapshotFunction = { unreadable: true };
const NAME = "([^\\s(){}]+)";
const INLINE_HEADER_RE = new RegExp(`^(?:function\\s+)?${NAME}\\s*\\(\\)\\s*\\{\\s*$|^function\\s+${NAME}\\s*\\{\\s*$`);
const OPEN_HEADER_RE = new RegExp(`^${NAME}\\s*\\(\\)\\s*$`);
const BRACE_RE = /^\{\s*$/;
const CLOSE_RE = /^\}\s*$/;

interface Header {
  name: string;
  bodyStart: number;
}

/**
 * Reads only the snapshot's `# Functions` section. Claude Code appends its own `rg` and `pkill` wrappers after
 * `# Aliases`; those are never read. A column-0 `}` that is not followed by a header or the section end may be
 * heredoc text, so that function, and every name until a header that follows a `}`, is unreadable.
 */
export function parseSnapshotFunctions(text: string): FunctionTable {
  const lines = text.split("\n");
  const table = new Map<string, SnapshotFunction>();
  let i = lines.indexOf(SECTION) + 1;
  if (i === 0) return table;
  let atBoundary = true;
  let last: string | null = null;
  while (i < lines.length) {
    const line = lines[i] as string;
    const header = headerAt(lines, i);
    if (line.trim() === "") i++;
    else if (atBoundary && line.startsWith("# ")) break;
    else if (header && atBoundary) {
      const next = readFunction(lines, header, table);
      if (next === null) break;
      [i, last] = [next, header.name];
    } else if (header) {
      table.set(header.name, UNREADABLE);
      [i, atBoundary] = [header.bodyStart, false];
    } else {
      if (last !== null) table.set(last, UNREADABLE);
      [i, atBoundary] = [i + 1, CLOSE_RE.test(line)];
    }
  }
  return table;
}

/** `NAME () {` or `function NAME {` on one line (zsh), or `NAME () ` then `{` (bash `declare -f`). */
function headerAt(lines: string[], i: number): Header | null {
  const line = lines[i] as string;
  const inline = INLINE_HEADER_RE.exec(line);
  if (inline) return { name: (inline[1] ?? inline[2]) as string, bodyStart: i + 1 };
  const open = OPEN_HEADER_RE.exec(line);
  if (open && BRACE_RE.test(lines[i + 1] ?? "")) return { name: open[1] as string, bodyStart: i + 2 };
  return null;
}

/** Records the body up to the first column-0 `}`; the line after it, or null when the body is cut off. */
function readFunction(lines: string[], header: Header, table: Map<string, SnapshotFunction>): number | null {
  for (let j = header.bodyStart; j < lines.length; j++) {
    if (!CLOSE_RE.test(lines[j] as string)) continue;
    table.set(header.name, { body: lines.slice(header.bodyStart, j).join("\n") });
    return j + 1;
  }
  table.set(header.name, UNREADABLE);
  return null;
}
