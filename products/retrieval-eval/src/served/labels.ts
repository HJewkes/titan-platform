import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readHead, transcriptId } from "../corpus/transcripts.js";
import { sessionDirs } from "../mine/bootstrap-arm.js";
import { readFrontmatter, scalarField } from "../mine/frontmatter.js";
import type { RefClass, ServedRef } from "./blocks.js";
import type { ServedBlock } from "./session.js";

/**
 * The labels one served ref earns, and the control it is compared with.
 *
 * `opened` is design §1.2's test: the ref's filename (or task id) appears in a
 * later tool input, which covers Read, Bash `cat`/`sed` and Grep paths alike.
 */

export interface RefLabels {
  opened: boolean;
  cited: boolean;
}

/** Why `opened-section` is not measured yet; reported instead of a zero that looks like a finding. */
export const OPENED_SECTION_UNAVAILABLE =
  "n/a: rendered refs carry no span anchor yet (design B4), so no Read offset/limit can be matched to a served section";

export function isOpened(ref: ServedRef, block: ServedBlock): boolean {
  return block.toolInputs.some((input) => input.includes(ref.key));
}

/** Named in assistant prose or in the session record written at wrap: used without necessarily being opened. */
export function isCited(ref: ServedRef, block: ServedBlock, wrapRecord?: string): boolean {
  return block.assistantText.some((text) => text.includes(ref.key)) || (wrapRecord?.includes(ref.key) ?? false);
}

export function labelRef(ref: ServedRef, block: ServedBlock, wrapRecord?: string): RefLabels {
  return { opened: isOpened(ref, block), cited: isCited(ref, block, wrapRecord) };
}

/** The classes a base rate is computed for; a task id is a substring of too much to be fair. */
export const BASE_RATE_CLASSES = ["source", "note"] as const satisfies readonly RefClass[];
export type BaseRateClass = (typeof BASE_RATE_CLASSES)[number];

const CLASS_DIR: Record<BaseRateClass, string[]> = { source: ["sources"], note: ["sources", "notes"] };

/** Same-class `.md` filenames on disk for an initiative; memoised because every block asks again. */
export function corpusLister(activeRoot: string): (initiative: string, refClass: BaseRateClass) => string[] {
  const cache = new Map<string, string[]>();
  return (initiative, refClass) => {
    const dir = path.join(activeRoot, initiative, ...CLASS_DIR[refClass]);
    let names = cache.get(dir);
    if (names === undefined) {
      names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".md")) : [];
      cache.set(dir, names);
    }
    return names;
  };
}

export interface BaseRateCount {
  initiative: string;
  refClass: BaseRateClass;
  unserved: number;
  opened: number;
}

/**
 * The control: every same-class file in each served initiative that this block
 * did NOT serve, tested with the same filename match. Served files are the
 * topical ones by construction, so this bounds coincidence only loosely.
 */
export function unservedBaseRate(
  block: ServedBlock,
  listCorpus: (initiative: string, refClass: BaseRateClass) => string[],
): BaseRateCount[] {
  const served = new Set(block.refs.map((ref) => ref.key));
  const initiatives = new Set(
    block.refs.filter((ref) => ref.refClass === "note" || ref.refClass === "source").map((ref) => ref.initiative!),
  );
  const counts: BaseRateCount[] = [];
  for (const initiative of initiatives) {
    for (const refClass of BASE_RATE_CLASSES) {
      const unserved = listCorpus(initiative, refClass).filter((name) => !served.has(name));
      const opened = unserved.filter((name) => block.toolInputs.some((input) => input.includes(name))).length;
      counts.push({ initiative, refClass, unserved: unserved.length, opened });
    }
  }
  return counts;
}

/** Session records by the `session_id` they name, which is a transcript uuid or a `session_01…` harness id. */
export function indexWrapRecords(activeRoot: string): Map<string, string> {
  const byId = new Map<string, string>();
  if (!existsSync(activeRoot)) return byId;
  for (const { dir } of sessionDirs(activeRoot)) {
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".md"))) {
      const text = readFileSync(path.join(dir, name), "utf8");
      const frontmatter = readFrontmatter(text);
      const id = frontmatter ? scalarField(frontmatter, "session_id") : undefined;
      if (id !== undefined) byId.set(id, (byId.get(id) ?? "") + text);
    }
  }
  return byId;
}

export async function wrapRecordFor(file: string, records: Map<string, string>): Promise<string | undefined> {
  const direct = records.get(transcriptId(file));
  if (direct !== undefined) return direct;
  const { harnessSessionId } = await readHead(file);
  return harnessSessionId ? records.get(harnessSessionId) : undefined;
}
