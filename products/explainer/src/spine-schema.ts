import { z } from "zod";
import { labelKey } from "./pace-items.js";

const Text = z.string().min(1);
/** A table cell the planner left as a dash ("—", "-"): read as absent, not as a value. */
const Optional = Text.nullable();
const List = z.array(Text);

/** The declared kinds a ledger item may take (script-method §3a); M6 compares them, so they are a closed set. */
export const SPINE_ITEM_KINDS = ["step", "property", "constraint", "invariant", "part", "number", "concept", "left-out"] as const;

/**
 * A list beat's declared shape. A `contrast` beat (old → new → why, or a split map's old and new pins) mixes
 * kinds by design, so only `parallel` beats, the default for a beat §9 does not name, have their kinds compared.
 */
export const SPINE_LIST_SHAPES = ["parallel", "contrast"] as const;

const JourneyRow = z
  .object({ n: z.number().int().positive(), step: Text, what: Text, why: Text, invariant: Optional, breaksToday: Optional })
  .strict();
const ArchitectureRow = z.object({ part: Text, carries: List, mechanism: Optional, constraint: Optional }).strict();
const ConstraintRow = z.object({ constraint: Text, forces: Text }).strict();
const LedgerRow = z.object({ item: Text, kind: z.enum(SPINE_ITEM_KINDS), definedIn: Text, reusedIn: List }).strict();
const ChapterRow = z.object({ chapter: Text, question: Text, rows: List }).strict();
const ShapeRow = z.object({ beat: Text, shape: z.enum(SPINE_LIST_SHAPES) }).strict();

/** `spine/v1`: the story spine's tables, parsed from the planner's spine.md before any beat is written. */
export const SpineSchema = z
  .object({
    schema: z.literal("spine/v1"),
    id: Text,
    journey: z.array(JourneyRow).min(1),
    architecture: z.array(ArchitectureRow).min(1),
    constraints: z.array(ConstraintRow),
    ledger: z.array(LedgerRow).min(1),
    chapters: z.array(ChapterRow).default([]),
    shapes: z.array(ShapeRow).default([]),
  })
  .strict()
  .superRefine((spine, ctx) => {
    const seen = new Set<string>();
    spine.ledger.forEach((row, i) => {
      const key = labelKey(row.item);
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["ledger", i, "item"], message: `duplicate ledger item "${row.item}"` });
      seen.add(key);
    });
  });

export type SpineV1 = z.infer<typeof SpineSchema>;
export type SpineLedgerRow = SpineV1["ledger"][number];

/** The beats §9 declares `contrast`. */
export const contrastBeats = (spine: SpineV1): ReadonlySet<string> =>
  new Set(spine.shapes.filter((row) => row.shape === "contrast").map((row) => row.beat));

/** The spine template's numbered sections that carry a table, by the number in their `## <n>.` heading. */
const TABLE_SECTIONS = { journey: 3, architecture: 4, constraints: 5, ledger: 6, chapters: 8, shapes: 9 } as const;
type TableName = keyof typeof TABLE_SECTIONS;
const TABLE_NAMES: readonly TableName[] = ["journey", "architecture", "constraints", "ledger", "chapters", "shapes"];

const DASH = /^[-—–]$/;
const cell = (text: string): string | null => (DASH.test(text) || text === "" ? null : text);
const list = (text: string): string[] => (cell(text) === null ? [] : text.split(",").map((s) => s.trim()).filter(Boolean));
// A planner may write a two-word kind with a space ("left out"); the closed set spells it with a hyphen.
const word = (text: string): string => text.toLowerCase().replace(/\s+/g, "-");

// An escaped pipe (`\|`) inside a cell is text, not a column break.
function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

const isSeparator = (cells: readonly string[]): boolean => cells.every((c) => /^:?-{3,}:?$/.test(c));

/** The body rows of the first pipe table in `lines`; the header and its separator are dropped. */
function tableRows(lines: readonly string[]): string[][] {
  const start = lines.findIndex((l) => l.trim().startsWith("|"));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && !l.trim().startsWith("|"));
  const rows = lines.slice(start, end < 0 ? lines.length : end).map(splitRow);
  return rows.slice(1).filter((cells) => !isSeparator(cells));
}

/** Each `## <n>.` section's lines, keyed by n. */
function sections(markdown: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let current: string[] | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(\d+)\./.exec(line);
    if (heading) out.set(Number(heading[1]), (current = []));
    else if (/^#{1,2}\s/.test(line)) current = undefined;
    else current?.push(line);
  }
  return out;
}

const ROW_READERS: Record<TableName, (c: string[]) => Record<string, unknown>> = {
  journey: ([n = "", step = "", what = "", why = "", invariant = "", breaks = ""]) => ({
    n: Number(n),
    step,
    what,
    why,
    invariant: cell(invariant),
    breaksToday: cell(breaks),
  }),
  architecture: ([part = "", carries = "", mechanism = "", constraint = ""]) => ({ part, carries: list(carries), mechanism: cell(mechanism), constraint: cell(constraint) }),
  constraints: ([constraint = "", forces = ""]) => ({ constraint, forces }),
  ledger: ([item = "", kind = "", definedIn = "", reusedIn = ""]) => ({ item, kind: word(kind), definedIn, reusedIn: list(reusedIn) }),
  chapters: ([chapter = "", question = "", rows = ""]) => ({ chapter, question, rows: list(rows) }),
  shapes: ([beat = "", shape = ""]) => ({ beat, shape: word(shape) }),
};

const WIDTHS: Record<TableName, number> = { journey: 6, architecture: 4, constraints: 2, ledger: 4, chapters: 3, shapes: 2 };

function readTable(name: TableName, found: Map<number, string[]>): Record<string, unknown>[] | undefined {
  const lines = found.get(TABLE_SECTIONS[name]);
  if (!lines) return undefined;
  return tableRows(lines).map((cells, i) => {
    if (cells.length !== WIDTHS[name]) throw new Error(`spine §${TABLE_SECTIONS[name]} (${name}) row ${i + 1} has ${cells.length} cells, expected ${WIDTHS[name]}`);
    return ROW_READERS[name](cells);
  });
}

/**
 * Parses a story-spine markdown file (the script-method §3a template) into `spine/v1`. Sections are found by
 * their number, so a planner may retitle them; §8 (chapter order) and §9 (list shapes) are optional, §3-§6 are required.
 */
export function parseSpine(markdown: string): SpineV1 {
  const id = /^#\s+Story spine:\s*(.+?)\s*$/m.exec(markdown)?.[1];
  const found = sections(markdown);
  const tables = Object.fromEntries(
    TABLE_NAMES.flatMap((name) => {
      const rows = readTable(name, found);
      return rows === undefined ? [] : [[name, rows]];
    }),
  );
  return SpineSchema.parse({ schema: "spine/v1", id, ...tables });
}
