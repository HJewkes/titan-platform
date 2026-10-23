import { z } from "zod";

/** One fact as the material map reads it: an id, the claim text, and the gather fields that sharpen a cue. */
export interface MaterialFact {
  id: string;
  text: string;
  kind?: string;
  priority?: string;
  group?: string;
  verdict?: string;
}

export type FactsFormat = "facts-md" | "facts-jsonl";

/** A gather fact (`ExplainerFactSchema`'s fields the map reads); the other fields pass through unread. */
const JsonlFactSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  kind: z.string().optional(),
  priority: z.string().optional(),
  tier: z.string().optional(),
  group: z.string().optional(),
  verdict: z.string().optional(),
});

function parseJsonl(text: string): MaterialFact[] {
  return text.split("\n").filter((line) => line.trim() !== "").map((line, i) => {
    const parsed = JsonlFactSchema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`facts.jsonl line ${i + 1}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    const { id, text: claim, kind, priority, tier, group, verdict } = parsed.data;
    const level = priority ?? tier;
    return { id, text: claim, ...(kind ? { kind } : {}), ...(level ? { priority: level } : {}), ...(group ? { group } : {}), ...(verdict ? { verdict } : {}) };
  });
}

const cells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
const isDivider = (line: string): boolean => /^\|?\s*:?-{3,}/.test(line.trim());

interface Columns {
  id: number;
  text: number;
  priority: number;
}

/** The facts table's columns by header name: `Id`, the first claim / fact / text column, and an optional priority. */
function columns(header: readonly string[]): Columns | undefined {
  const find = (pattern: RegExp) => header.findIndex((name) => pattern.test(name));
  const id = find(/^id$/i);
  if (id < 0) return undefined;
  const named = find(/claim|fact|text/i);
  return { id, text: named >= 0 ? named : id + 1, priority: find(/^(priority|tier)$/i) };
}

/** Every row of every markdown table whose header has an `Id` column; other tables and prose are not facts. */
function parseMarkdown(text: string): MaterialFact[] {
  const lines = text.split("\n");
  const facts: MaterialFact[] = [];
  let table: Columns | undefined;
  for (const [i, line] of lines.entries()) {
    if (!line.trim().startsWith("|")) {
      table = undefined;
      continue;
    }
    if (isDivider(line)) continue;
    if (!table) {
      table = isDivider(lines[i + 1] ?? "") ? columns(cells(line)) : undefined;
      continue;
    }
    const row = cells(line);
    const id = row[table.id];
    const claim = row[table.text];
    if (id && claim) facts.push({ id, text: claim, ...(row[table.priority] ? { priority: row[table.priority]! } : {}) });
  }
  return facts;
}

/** A facts pack is JSON lines when its first non-blank character opens an object, else markdown with a facts table. */
export function parseFacts(text: string): { format: FactsFormat; facts: MaterialFact[] } {
  const jsonl = text.trimStart().startsWith("{");
  const facts = jsonl ? parseJsonl(text) : parseMarkdown(text);
  if (facts.length === 0) throw new Error("the facts pack holds no facts: expected JSON lines or a markdown table with an Id column");
  const seen = new Set<string>();
  for (const fact of facts) {
    if (seen.has(fact.id)) throw new Error(`the facts pack lists fact ${fact.id} twice`);
    seen.add(fact.id);
  }
  return { format: jsonl ? "facts-jsonl" : "facts-md", facts };
}
