/** One line a digest may carry: its memory key, its PR ref, and for a gate the step and resolve command it waits on. */
export interface DigestItem {
  key: string;
  line: string;
  pr: string;
  gate?: { stepId: string; command: string };
}

/** What the seat was last told; `refs` is absent in memory written before deltas, so cleared items there have no ref. */
interface ToldState {
  open: readonly string[];
  refs?: Readonly<Record<string, string>>;
}

/** This many new gates on one step share a line, as one burst of main-red-again gates did. */
const COLLAPSE_AT = 3;

/** New items in order, with every step that has COLLAPSE_AT or more new gates folded into one line at its first gate. */
function newLines(added: readonly DigestItem[]): string[] {
  const byStep = new Map<string, DigestItem[]>();
  for (const item of added) if (item.gate) byStep.set(item.gate.stepId, [...(byStep.get(item.gate.stepId) ?? []), item]);
  const lines: string[] = [];
  for (const item of added) {
    const group = item.gate && byStep.get(item.gate.stepId);
    if (!group || group.length < COLLAPSE_AT) lines.push(item.line);
    else if (group[0] === item) {
      const commands = group.map((g) => `\`${g.gate!.command}\``).join(", ");
      lines.push(`- ${group.length} wait on ${item.gate!.stepId}: ${group.map((g) => g.pr).join(", ")}; resolve each with ${commands}`);
    }
  }
  return lines;
}

/** One line naming the PRs whose open items cleared; a key from memory with no ref is only counted. */
function clearedLine(cleared: readonly string[], refs: Readonly<Record<string, string>> | undefined): string {
  const named = [...new Set(cleared.flatMap((key) => (refs?.[key] === undefined ? [] : [refs[key]])))];
  const unnamed = cleared.filter((key) => refs?.[key] === undefined).length;
  const tail = unnamed === 0 ? "" : `${named.length > 0 ? ", and " : ""}${unnamed} item${unnamed === 1 ? "" : "s"} from before deltas`;
  return `Cleared: ${named.join(", ")}${tail}`;
}

/**
 * Unchanged gates fold into a count, since `titan-factory shepherd waiting` lists every pending gate; an unchanged item
 * of any other kind, such as a seat-fix round, has no command that lists it, so it is listed again in full.
 */
function unchangedLines(unchanged: readonly DigestItem[]): string[] {
  const gates = unchanged.filter((item) => item.gate !== undefined).length;
  const rest = unchanged.filter((item) => item.gate === undefined).map((item) => item.line);
  const lines = gates === 0 ? [] : [`Still open: ${gates} unchanged gate${gates === 1 ? "" : "s"}; \`titan-factory shepherd waiting\` lists them.`];
  return rest.length === 0 ? lines : [...lines, "Still to act on:", ...rest];
}

/** What changed since the seat was last told: open items it has not heard of, keys of told items now gone, and fresh runs. */
interface DigestDelta {
  open: DigestItem[];
  added: DigestItem[];
  cleared: string[];
  fresh: readonly DigestItem[];
}

export function digestDelta(open: readonly DigestItem[], fresh: readonly DigestItem[], last: ToldState | undefined): DigestDelta {
  const sorted = [...open].sort((a, b) => a.key.localeCompare(b.key));
  const told = new Set(last?.open ?? []);
  const now = new Set(sorted.map((item) => item.key));
  const added = last === undefined ? sorted : sorted.filter((item) => !told.has(item.key));
  return { open: sorted, added, cleared: [...told].filter((key) => !now.has(key)).sort(), fresh };
}

/**
 * A PR whose told item cleared while a new one opened on it moved, say from one gate to another; it reads as a change, so
 * its new item is listed under `Changed:` and its cleared key leaves the `Cleared:` line.
 */
function splitMoves(added: readonly DigestItem[], cleared: readonly string[], refs: Readonly<Record<string, string>> | undefined) {
  const movedFrom = new Set(cleared.flatMap((key) => (refs?.[key] === undefined ? [] : [refs[key]])));
  const changed = added.filter((item) => movedFrom.has(item.pr));
  const changedPrs = new Set(changed.map((item) => item.pr));
  return { changed, added: added.filter((item) => !changedPrs.has(item.pr)), cleared: cleared.filter((key) => refs?.[key] === undefined || !changedPrs.has(refs[key])) };
}

/**
 * The digest text, or undefined when nothing changed. A seat with no memory hears every open item; after that it hears
 * only what changed: new open items, items that moved on their PR, the PRs whose items cleared, newly finished runs, and
 * the unchanged rest per `unchangedLines`.
 */
export function digestText(seat: string, open: readonly DigestItem[], fresh: readonly DigestItem[], last: ToldState | undefined): string | undefined {
  const delta = digestDelta(open, fresh, last);
  const { open: sorted } = delta;
  if (delta.added.length === 0 && delta.cleared.length === 0 && fresh.length === 0) return undefined;
  const told = new Set(last?.open ?? []);
  const { changed, added, cleared } = last === undefined ? { changed: [], ...delta } : splitMoves(delta.added, delta.cleared, last.refs);
  const lines = [`Shepherd digest for ${seat}: ${sorted.length} open, ${fresh.length} newly finished.`];
  if (sorted.length === 0) lines.push("Open: none.");
  if (last === undefined && sorted.length > 0) lines.push("Open:", ...sorted.map((item) => item.line));
  if (last !== undefined && added.length > 0) lines.push("New:", ...newLines(added));
  if (changed.length > 0) lines.push("Changed:", ...changed.map((item) => item.line));
  if (cleared.length > 0) lines.push(clearedLine(cleared, last?.refs));
  if (last !== undefined) lines.push(...unchangedLines(sorted.filter((item) => told.has(item.key))));
  if (fresh.length > 0) lines.push("Finished:", ...fresh.map((item) => item.line));
  return lines.join("\n");
}
