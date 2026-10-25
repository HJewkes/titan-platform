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
 * The digest text, or undefined when nothing changed. A seat with no memory hears every open item; after that it hears
 * only what changed: new open items, the PRs whose items cleared, newly finished runs, and a count of the unchanged rest.
 */
export function digestText(seat: string, open: readonly DigestItem[], fresh: readonly DigestItem[], last: ToldState | undefined): string | undefined {
  const sorted = [...open].sort((a, b) => a.key.localeCompare(b.key));
  const told = new Set(last?.open ?? []);
  const added = last === undefined ? sorted : sorted.filter((item) => !told.has(item.key));
  const now = new Set(sorted.map((item) => item.key));
  const cleared = [...told].filter((key) => !now.has(key)).sort();
  if (added.length === 0 && cleared.length === 0 && fresh.length === 0) return undefined;
  const lines = [`Shepherd digest for ${seat}: ${sorted.length} open, ${fresh.length} newly finished.`];
  if (sorted.length === 0) lines.push("Open: none.");
  if (last === undefined && sorted.length > 0) lines.push("Open:", ...sorted.map((item) => item.line));
  if (last !== undefined && added.length > 0) lines.push("New:", ...newLines(added));
  if (cleared.length > 0) lines.push(clearedLine(cleared, last?.refs));
  const unchanged = sorted.length - added.length;
  if (unchanged > 0) lines.push(`Still open: ${unchanged} unchanged; \`titan-factory shepherd waiting\` lists them.`);
  if (fresh.length > 0) lines.push("Finished:", ...fresh.map((item) => item.line));
  return lines.join("\n");
}
