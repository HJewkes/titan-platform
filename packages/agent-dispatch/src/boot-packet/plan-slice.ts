/** A file the plan names, with the line it points at when it gives one. */
export interface TouchPoint {
  path: string;
  line?: number;
}

const HEADING = /^(#{1,6})\s/;

function mentions(text: string, slice: string): boolean {
  const escaped = slice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(text);
}

function headingSection(lines: string[], slice: string): string[] | null {
  const start = lines.findIndex((l) => HEADING.test(l) && mentions(l, slice));
  if (start === -1) return null;
  const level = HEADING.exec(lines[start] ?? "")?.[1]?.length ?? 1;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => (HEADING.exec(l)?.[1]?.length ?? 7) <= level);
  return [lines[start] ?? "", ...(end === -1 ? rest : rest.slice(0, end))];
}

/** Blank-line-separated blocks, except that a table keeps each row as its own block. */
function blocks(lines: string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) out.push(current.join("\n"));
    current = [];
  };
  for (const line of lines) {
    if (line.trim() === "" || line.startsWith("|")) flush();
    if (line.startsWith("|")) out.push(line);
    else if (line.trim() !== "") current.push(line);
  }
  flush();
  return out;
}

/**
 * The part of a plan about one slice: the section under a heading naming it, or, when no heading
 * does, every paragraph, list item and table row that mentions the slice id as a whole word.
 */
export function planSliceExcerpt(plan: string, slice: string): string | null {
  const lines = plan.split(/\r?\n/);
  const section = headingSection(lines, slice);
  if (section !== null) return section.join("\n").trim();
  const hits = blocks(lines).filter((b) => mentions(b, slice));
  return hits.length === 0 ? null : hits.join("\n\n");
}

const PATH_REF = /`([\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z]{1,5})(?::(\d+))?[^`]*`/g;

/** Backticked repo-relative paths in the text, first mention of each, with the first line number given. */
export function touchPointsIn(text: string, limit: number): TouchPoint[] {
  const seen = new Map<string, TouchPoint>();
  for (const m of text.matchAll(PATH_REF)) {
    const path = m[1] ?? "";
    if (seen.has(path) || path.split("/").includes("..")) continue;
    seen.set(path, m[2] === undefined ? { path } : { path, line: Number(m[2]) });
  }
  return [...seen.values()].slice(0, limit);
}
