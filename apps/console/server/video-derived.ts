/**
 * What the catalog can say about a render when no agent wrote it down: a title from the folder's
 * render notes or brief, a series and take from the file name, whether a later take replaced it,
 * and which files under a `copies` or `intermediate` folder only duplicate another render.
 * A sidecar or manifest value always beats a derived one.
 */
import type { Stats } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { OPEN_FLAGS } from "./rounds.js";
import { fingerprintOf, readAt } from "./video-media.js";

const DOC_HEAD_BYTES = 16 * 1024;
const MAX_CACHED_DOCS = 1024;
/** In precedence order: the notes on the render beat the brief it was made from. */
const TITLE_DOCS = ["render-notes.md", "BRIEF.md"] as const;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;
const COPY_DIRS = new Set(["copies", "intermediate"]);
const TAKE = /^(.+?)[-_. ]((?:v|take[-_]?)(\d{1,4}))$/i;

export interface FolderDocs {
  title?: string;
  description?: string;
}

const docsCache = new Map<string, FolderDocs>();

/** The first of the folder's docs with an H1; a doc that cannot be read counts as absent. */
export async function readFolderDocs(dir: string, names: ReadonlySet<string>): Promise<FolderDocs> {
  for (const name of TITLE_DOCS) {
    const docs = names.has(name) ? await readDoc(path.join(dir, name)) : {};
    if (docs.title !== undefined) return docs;
  }
  return {};
}

async function readDoc(file: string): Promise<FolderDocs> {
  const handle = await open(file, OPEN_FLAGS).catch(() => null);
  if (handle === null) return {};
  try {
    const info = await handle.stat();
    if (!info.isFile()) return {};
    const key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    const cached = docsCache.get(key);
    if (cached !== undefined) return cached;
    if (docsCache.size >= MAX_CACHED_DOCS) docsCache.delete(docsCache.keys().next().value!);
    const docs = parseDoc((await readAt(handle, 0, DOC_HEAD_BYTES)).toString("utf8"));
    docsCache.set(key, docs);
    return docs;
  } catch {
    return {};
  } finally {
    await handle.close();
  }
}

/** The first H1, and the first paragraph after it as the description. */
export function parseDoc(text: string): FolderDocs {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (at === -1) return {};
  const title = lines[at]!.replace(/^#\s+/, "").replace(/\s+#+\s*$/, "").trim().slice(0, MAX_TITLE);
  const rest = lines.slice(at + 1);
  const start = rest.findIndex((line) => line.trim() !== "");
  const paragraph = [];
  for (const line of start === -1 ? [] : rest.slice(start)) {
    if (line.trim() === "" || line.startsWith("#")) break;
    paragraph.push(line.trim());
  }
  const description = paragraph.join(" ").slice(0, MAX_DESCRIPTION);
  return description === "" ? { title } : { title, description };
}

/** `lantern-v2` is take `v2` of series `lantern`; a stem with no take suffix has neither. */
export function takeOf(stem: string): { series: string; take: string } | null {
  const match = TAKE.exec(stem);
  return match === null ? null : { series: match[1]!, take: match[2]! };
}

interface Derivable {
  group: string;
  stem: string;
  modifiedAt: string;
  meta: { title?: string; description?: string; series?: string; take?: string; status?: string };
  docs: FolderDocs;
}

export interface Derived {
  title: string;
  description?: string;
  series?: string;
  take?: string;
  superseded: boolean;
}

/** One result per row, in order; each field takes the row's own meta first. */
export function deriveFields(rows: readonly Derivable[]): Derived[] {
  const named = rows.map(({ stem, meta, docs }) => {
    const fromName = takeOf(stem);
    return { title: meta.title ?? docs.title ?? stem, series: meta.series ?? fromName?.series, take: meta.take ?? fromName?.take };
  });
  const titleCounts = countBy(rows.map((row, index) => `${row.group}\0${named[index]!.title}`));
  const latest = latestTakes(rows, named);
  return rows.map((row, index) => {
    const { title, series, take } = named[index]!;
    const shared = row.meta.title === undefined && titleCounts.get(`${row.group}\0${title}`)! > 1;
    const description = row.meta.description ?? row.docs.description;
    return {
      title: shared ? `${title} (${take ?? row.stem})`.slice(0, MAX_TITLE) : title,
      ...(description === undefined ? {} : { description }),
      ...(series === undefined ? {} : { series }),
      ...(take === undefined ? {} : { take }),
      superseded: row.meta.status !== undefined ? row.meta.status === "superseded" : series !== undefined && take !== undefined && latest.get(seriesKey(row, series)) !== index,
    };
  });
}

function countBy(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

const seriesKey = (row: Derivable, series: string) => `${row.group}\0${series}`;

const takeNumber = (take: string) => Number(/\d+/.exec(take)?.[0] ?? 0);

/** Per folder and series, the index of the highest take, the newer file breaking a tie. Rows with no take never supersede. */
function latestTakes(rows: readonly Derivable[], named: readonly { series?: string; take?: string }[]): Map<string, number> {
  const latest = new Map<string, number>();
  named.forEach(({ series, take }, index) => {
    if (series === undefined || take === undefined) return;
    const key = seriesKey(rows[index]!, series);
    const best = latest.get(key);
    if (best === undefined || isLater(rows, named, index, best)) latest.set(key, index);
  });
  return latest;
}

function isLater(rows: readonly Derivable[], named: readonly { take?: string }[], index: number, than: number): boolean {
  const byTake = takeNumber(named[index]!.take!) - takeNumber(named[than]!.take!);
  return byTake !== 0 ? byTake > 0 : rows[index]!.modifiedAt > rows[than]!.modifiedAt;
}

interface Foldable {
  file: string;
  relative: string;
  info: Stats;
}

/** True for a file under a `copies` or `intermediate` folder: the only files that ever fold. */
function isCopyPath(relative: string): boolean {
  return path.dirname(relative).split(path.sep).some((segment) => COPY_DIRS.has(segment.toLowerCase()));
}

/**
 * Folds each copy-folder file into an identical render elsewhere, or, when every identical file is a
 * copy, into the first by path. Only sizes shared with a copy are hashed, so most files never are.
 */
export async function foldCopies<T extends Foldable>(rows: readonly T[]): Promise<{ row: T; copies: number }[]> {
  const bySize = new Map<number, T[]>();
  for (const row of rows) bySize.set(row.info.size, [...(bySize.get(row.info.size) ?? []), row]);
  const folded = new Map<T, T>();
  for (const same of bySize.values()) {
    if (same.length > 1 && same.some((row) => isCopyPath(row.relative))) await foldSameSize(same, folded);
  }
  const copies = new Map<T, number>();
  for (const keeper of folded.values()) copies.set(keeper, (copies.get(keeper) ?? 0) + 1);
  return rows.filter((row) => !folded.has(row)).map((row) => ({ row, copies: copies.get(row) ?? 0 }));
}

async function foldSameSize<T extends Foldable>(same: readonly T[], folded: Map<T, T>): Promise<void> {
  const byPrint = new Map<string, T[]>();
  for (const row of same) {
    const print = await fingerprintOf(row.file, row.info);
    if (print !== null) byPrint.set(print, [...(byPrint.get(print) ?? []), row]);
  }
  for (const identical of byPrint.values()) {
    const ordered = [...identical].sort((a, b) => Number(isCopyPath(a.relative)) - Number(isCopyPath(b.relative)) || a.relative.localeCompare(b.relative));
    const keeper = ordered[0]!;
    for (const row of ordered.slice(1)) if (isCopyPath(row.relative)) folded.set(row, keeper);
  }
}
