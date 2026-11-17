import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "@titan-design/locator";
import { parse, stringify } from "yaml";
import type { ZodType } from "zod";
import { BetSchema, FreezeSchema, IntentLineSchema, OutcomeSchema, OutOfScopeSchema } from "../planning.js";
import type { Bet, Freeze, IntentLine, OutOfScope, Outcome } from "../planning.js";
import { PlanStoreError } from "./plan-errors.js";

/*
 * Planning records: one validated file per record under <activeRoot>/<initiative>/plan/<kind dir>/, named by the
 * id's suffix. A bet keeps its week as a field, so a later selection never moves its file.
 */

export interface PlanRecords {
  outcome: Outcome;
  bet: Bet;
  freeze: Freeze;
  "out-of-scope": OutOfScope;
  intent: IntentLine;
}

export type PlanKind = keyof PlanRecords;

interface KindSpec<K extends PlanKind> {
  dir: string;
  label: string;
  schema: ZodType<PlanRecords[K]>;
}

const KINDS: { [K in PlanKind]: KindSpec<K> } = {
  outcome: { dir: "outcomes", label: "Outcome", schema: OutcomeSchema },
  bet: { dir: "bets", label: "Bet", schema: BetSchema },
  freeze: { dir: "freezes", label: "Freeze", schema: FreezeSchema },
  "out-of-scope": { dir: "out-of-scope", label: "Out-of-scope record", schema: OutOfScopeSchema },
  intent: { dir: "intent", label: "Intent line", schema: IntentLineSchema },
};

export function planSchema<K extends PlanKind>(kind: K): ZodType<PlanRecords[K]> {
  return KINDS[kind].schema;
}

export function planLabel(kind: PlanKind): string {
  return KINDS[kind].label;
}

function planKindDir(activeRoot: string, initiative: string, kind: PlanKind): string {
  return path.join(activeRoot, initiative, "plan", KINDS[kind].dir);
}

/** Splits `<initiative>/<suffix>`; null when the id has no initiative prefix or a suffix unfit for a filename. */
function splitPlanId(id: string): { initiative: string; suffix: string } | null {
  const match = /^([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9-]*)$/.exec(id);
  return match === null ? null : { initiative: match[1]!, suffix: match[2]! };
}

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

async function readRecordFile<T>(filePath: string, schema: ZodType<T>): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse YAML at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(`Schema validation failed for ${filePath}: ${result.error.message}`);
  return result.data;
}

/** Every record of one kind in one initiative, in filename order; a missing folder holds none. */
export async function loadPlanRecords<K extends PlanKind>(activeRoot: string, initiative: string, kind: K): Promise<PlanRecords[K][]> {
  const dir = planKindDir(activeRoot, initiative, kind);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((file) => file.endsWith(".yml")).sort();
  } catch (err) {
    if (isMissingFile(err)) return [];
    throw err;
  }
  return Promise.all(files.map((file) => readRecordFile(path.join(dir, file), KINDS[kind].schema)));
}

/** The record the id names, or null when the id is malformed or no such file exists; a file that fails its schema throws. */
export async function readPlanRecord<K extends PlanKind>(activeRoot: string, kind: K, id: string): Promise<PlanRecords[K] | null> {
  const parts = splitPlanId(id);
  if (parts === null) return null;
  const file = path.join(planKindDir(activeRoot, parts.initiative, kind), `${parts.suffix}.yml`);
  try {
    return await readRecordFile(file, KINDS[kind].schema);
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }
}

/** Validates the record before any disk write, then writes it atomically to the file its id names. */
export async function writePlanRecord<K extends PlanKind>(activeRoot: string, kind: K, record: PlanRecords[K]): Promise<PlanRecords[K]> {
  const { schema, label } = KINDS[kind];
  const parsed = schema.safeParse(record);
  const parts = splitPlanId(record.id);
  if (!parsed.success) throw new PlanStoreError("invalid", `Invalid ${label.toLowerCase()} ${record.id}: ${parsed.error.message}`);
  if (parts === null) throw new PlanStoreError("invalid", `Invalid ${label.toLowerCase()} id: ${record.id}`);
  const dir = planKindDir(activeRoot, parts.initiative, kind);
  await fs.mkdir(dir, { recursive: true });
  await atomicWrite(path.join(dir, `${parts.suffix}.yml`), stringify(parsed.data));
  return parsed.data;
}

/*
 * A lane is a named run of intent lines inside one initiative (`<lane>/I<n>` under `<initiative>/plan/intent/<lane>/`).
 * The subfolder keeps lane lines out of the initiative's own `loadPlanRecords(..., "intent")` listing.
 */
function laneDir(activeRoot: string, initiative: string, lane: string): string {
  return path.join(planKindDir(activeRoot, initiative, "intent"), lane);
}

/** Every intent line of one lane, in filename order; a missing lane holds none. */
export async function loadLaneIntentLines(activeRoot: string, initiative: string, lane: string): Promise<IntentLine[]> {
  const dir = laneDir(activeRoot, initiative, lane);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((file) => file.endsWith(".yml")).sort();
  } catch (err) {
    if (isMissingFile(err)) return [];
    throw err;
  }
  return Promise.all(files.map((file) => readRecordFile(path.join(dir, file), IntentLineSchema)));
}

/** Validates the line, then writes it atomically under its lane; the id's prefix must be the lane. */
export async function writeLaneIntentLine(activeRoot: string, initiative: string, lane: string, line: IntentLine): Promise<IntentLine> {
  const parsed = IntentLineSchema.safeParse(line);
  if (!parsed.success) throw new PlanStoreError("invalid", `Invalid intent line ${line.id}: ${parsed.error.message}`);
  const parts = splitPlanId(line.id);
  if (parts === null || parts.initiative !== lane) throw new PlanStoreError("invalid", `Intent line ${line.id} is not in lane ${lane}`);
  const dir = laneDir(activeRoot, initiative, lane);
  await fs.mkdir(dir, { recursive: true });
  await atomicWrite(path.join(dir, `${parts.suffix}.yml`), stringify(parsed.data));
  return parsed.data;
}

/** The next free `<initiative>/<letter><n>` id, one above the highest number in use. */
export function nextPlanId(initiative: string, letter: string, records: readonly { id: string }[]): string {
  const pattern = new RegExp(`/${letter}(\\d+)$`);
  const used = records.map((record) => Number(pattern.exec(record.id)?.[1] ?? 0));
  return `${initiative}/${letter}${Math.max(0, ...used) + 1}`;
}
