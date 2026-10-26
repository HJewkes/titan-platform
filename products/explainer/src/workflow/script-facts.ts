import type { SpineV1 } from "../spine-schema.js";

/**
 * A chapter call's facts: the rows that chapter may cite. A fact is placed in a chapter by the facts table's Beats
 * column, or by the spine's Cites table through the ledger's defined-in and reused-in entries. A fact placed nowhere,
 * or at a beat no chapter claims, stays in every chapter's slice, so a slice never drops a fact the chapter could need.
 * The whole-video repair still gets the whole pack, and L0 always reads the whole pack.
 */
export type FactPlaces = ReadonlyMap<string, ReadonlySet<string>>;

interface Table {
  header: string[];
  rows: { line: number; cells: string[] }[];
}

const cells = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
const isDivider = (line: string): boolean => /^\|?\s*:?-{3,}/.test(line.trim());
const isRow = (line: string): boolean => line.trim().startsWith("|");

/** Every markdown table in `text`: its header cells and its rows, each with its line number. */
function tables(text: string): Table[] {
  const lines = text.split("\n");
  const found: Table[] = [];
  let table: Table | undefined;
  for (const [i, line] of lines.entries()) {
    if (!isRow(line)) table = undefined;
    else if (table && !isDivider(line)) table.rows.push({ line: i, cells: cells(line) });
    else if (!table && isDivider(lines[i + 1] ?? "")) found.push((table = { header: cells(line), rows: [] }));
  }
  return found;
}

const column = (table: Table, pattern: RegExp): number => table.header.findIndex((name) => pattern.test(name));
const list = (cell: string | undefined): string[] => (cell ?? "").split(/[,\s]+/).filter((entry) => entry !== "" && entry !== "—");

/** The number a chapter or beat id carries after its letters: `ch3b` and `r3b-1-run` both carry `3b`. */
const ordinal = (id: string): string | undefined => /^[a-z]*(\d\w*)$/i.exec(id.split("-")[0]!)?.[1];

/** The chapter a beat id names: the chapter itself, a beat prefixed with its id, or a beat carrying its number. */
export function chapterOf(beat: string, chapters: readonly string[]): string | undefined {
  if (chapters.includes(beat)) return beat;
  const prefixed = chapters.filter((id) => beat.startsWith(`${id}-`)).sort((a, b) => b.length - a.length)[0];
  return prefixed ?? chapters.find((id) => ordinal(id) !== undefined && ordinal(id) === ordinal(beat));
}

/** Fact id to the beats that cite it: the facts table's Beats column, and the spine's Cites table through the ledger. */
function citedAt(spineText: string, spine: SpineV1, factsText: string): Map<string, string[]> {
  const at = new Map<string, string[]>();
  const add = (fact: string, beats: readonly string[]) => at.set(fact, [...(at.get(fact) ?? []), ...beats]);
  for (const table of tables(factsText)) {
    const [id, beats] = [column(table, /^id$/i), column(table, /^beats?$/i)];
    if (id >= 0 && beats >= 0) table.rows.forEach((row) => add(row.cells[id] ?? "", list(row.cells[beats])));
  }
  const ledger = new Map(spine.ledger.map((row) => [row.item.toLowerCase(), [row.definedIn, ...row.reusedIn]]));
  for (const table of tables(spineText)) {
    const [item, facts] = [column(table, /^item$/i), column(table, /^facts?$/i)];
    if (item < 0 || facts < 0) continue;
    table.rows.forEach((row) => list(row.cells[facts]).forEach((fact) => add(fact, ledger.get((row.cells[item] ?? "").toLowerCase()) ?? [""])));
  }
  return at;
}

/** Each placed fact's chapters; a fact with any beat no chapter claims is left out, so it goes to every chapter. */
export function factPlaces(spineText: string, spine: SpineV1, factsText: string): FactPlaces {
  const chapters = spine.chapters.map((row) => row.chapter);
  const places = new Map<string, Set<string>>();
  for (const [fact, beats] of citedAt(spineText, spine, factsText)) {
    const owners = beats.map((beat) => chapterOf(beat, chapters));
    if (beats.length > 0 && owners.every((owner) => owner !== undefined)) places.set(fact, new Set(owners));
  }
  return places;
}

const mine = (places: FactPlaces, chapter: string) => (fact: string | undefined): boolean =>
  fact === undefined || !places.has(fact) || places.get(fact)!.has(chapter);

/** JSON lines keep the lines of the chapter's facts; markdown keeps its prose and drops other chapters' fact rows. */
export function factsSlice(factsText: string, places: FactPlaces, chapter: string): string {
  const keep = mine(places, chapter);
  const lines = factsText.split("\n");
  if (factsText.trimStart().startsWith("{")) return lines.filter((line) => keep(jsonlId(line))).join("\n");
  const dropped = new Set(
    tables(factsText).flatMap((table) => {
      const id = column(table, /^id$/i);
      return id < 0 ? [] : table.rows.filter((row) => !keep(row.cells[id])).map((row) => row.line);
    }),
  );
  return lines.filter((_, i) => !dropped.has(i)).join("\n");
}

function jsonlId(line: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    const id = typeof parsed === "object" && parsed !== null ? (parsed as { id?: unknown }).id : undefined;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}
