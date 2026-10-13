import { atTopLevel, newBodyScan, scanLine } from "./snapshot-body.js";

/** A function from a shell snapshot: its body text, or unreadable when its end could not be found. */
type SnapshotFunction = { body: string } | { unreadable: true };

/**
 * The functions the shell holds after sourcing the snapshot. `incomplete` means the section could not be read to
 * its end, so a name missing from `functions` may still be a function.
 */
interface FunctionTable {
  functions: ReadonlyMap<string, SnapshotFunction>;
  incomplete: boolean;
}

const SECTION = "# Functions";
const UNREADABLE: SnapshotFunction = { unreadable: true };
const NAME = "([^\\s(){}'\"]+)";
const INLINE_HEADER_RE = new RegExp(`^(?:function\\s+)?${NAME}\\s*\\(\\)\\s*\\{\\s*$|^function\\s+${NAME}\\s*\\{\\s*$`);
const OPEN_HEADER_RE = new RegExp(`^${NAME}\\s*\\(\\)\\s*$`);
const BRACE_RE = /^\{\s*$/;
const CLOSE_RE = /^\}\s*$/;

interface Header {
  name: string;
  bodyStart: number;
}

/**
 * Reads only the snapshot's `# Functions` section; Claude Code's own `rg` and `pkill` wrappers after `# Aliases`
 * are never read. A body ends at the first column-0 `}` that lies outside every heredoc and quote, so verbatim body
 * text never steers the parser. Anything else out of step stops the read and marks the table incomplete. So do two
 * tripwires for a misjudged heredoc or quote: a body holding a column-0 `}` followed by a header has suspect later
 * functions, and a name defined twice cannot come from `typeset -f`, which prints each function once.
 */
export function parseSnapshotFunctions(text: string, findBodyEnd = bodyEnd): FunctionTable {
  const lines = text.split("\n");
  const functions = new Map<string, SnapshotFunction>();
  const start = lines.indexOf(SECTION);
  if (start === -1) return { functions, incomplete: lines.some((line) => line.trimEnd() === SECTION) };
  let last: string | null = null;
  let suspect = false;
  for (let i = start + 1; i < lines.length; ) {
    const line = lines[i] ?? "";
    if (line.trim() === "") i++;
    else if (line.startsWith("# ")) return { functions, incomplete: suspect };
    else {
      const header = headerAt(lines, i);
      const end = header === null ? null : findBodyEnd(lines, header.bodyStart);
      const name = header?.name ?? last;
      if (header === null || end === null) {
        if (name !== null) functions.set(name, UNREADABLE);
        return { functions, incomplete: true };
      }
      const repeated = functions.has(header.name);
      functions.set(header.name, repeated ? UNREADABLE : { body: lines.slice(header.bodyStart, end).join("\n") });
      suspect ||= repeated || holdsHeader(lines, header.bodyStart, end);
      [i, last] = [end + 1, header.name];
    }
  }
  return { functions, incomplete: true };
}

function holdsHeader(lines: string[], from: number, end: number): boolean {
  for (let j = from; j < end; j++) {
    if (!CLOSE_RE.test(lines[j] ?? "")) continue;
    let next = j + 1;
    while (next < end && (lines[next] ?? "").trim() === "") next++;
    if (next < end && headerAt(lines, next) !== null) return true;
  }
  return false;
}

/** `NAME () {` or `function NAME {` on one line (zsh), or `NAME () ` then `{` (bash `declare -f`). */
function headerAt(lines: string[], i: number): Header | null {
  const line = lines[i] ?? "";
  const inline = INLINE_HEADER_RE.exec(line);
  const inlineName = inline?.[1] ?? inline?.[2];
  if (inlineName !== undefined) return { name: inlineName, bodyStart: i + 1 };
  const openName = OPEN_HEADER_RE.exec(line)?.[1];
  if (openName !== undefined && BRACE_RE.test(lines[i + 1] ?? "")) return { name: openName, bodyStart: i + 2 };
  return null;
}

/** The line index of the column-0 `}` that closes the body, or null when the body is cut off. */
function bodyEnd(lines: string[], from: number): number | null {
  const scan = newBodyScan();
  for (let j = from; j < lines.length; j++) {
    const line = lines[j] ?? "";
    if (CLOSE_RE.test(line) && atTopLevel(scan)) return j;
    scanLine(scan, line);
  }
  return null;
}
