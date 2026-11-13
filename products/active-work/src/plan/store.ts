import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BetSchema,
  FreezeSchema,
  OutcomeSchema,
  OutOfScopeSchema,
  type Bet,
  type BetLookup,
  type Freeze,
  type Outcome,
  type OutOfScope,
} from '@titan-design/pm';
import type { ZodType } from 'zod';
import { NotFoundError, ValidationError } from '../errors.js';
import { loadAgentVisibility } from '../sessions/visibility.js';
import { listInitiativeSlugsOrEmpty } from '../sessions/initiatives.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';

/*
 * Planning records (TP-5453 P3): one validated file per record under <initiative>/plan/<kind dir>/, named by the id's
 * suffix. A bet keeps its week as a field, so a later selection never moves its file.
 */

export interface PlanRecords {
  outcome: Outcome;
  bet: Bet;
  freeze: Freeze;
  'out-of-scope': OutOfScope;
}

export type PlanKind = keyof PlanRecords;

interface KindSpec<K extends PlanKind> {
  dir: string;
  label: string;
  schema: ZodType<PlanRecords[K]>;
}

const KINDS: { [K in PlanKind]: KindSpec<K> } = {
  outcome: { dir: 'outcomes', label: 'Outcome', schema: OutcomeSchema },
  bet: { dir: 'bets', label: 'Bet', schema: BetSchema },
  freeze: { dir: 'freezes', label: 'Freeze', schema: FreezeSchema },
  'out-of-scope': { dir: 'out-of-scope', label: 'Out-of-scope record', schema: OutOfScopeSchema },
};

export function planSchema<K extends PlanKind>(kind: K): ZodType<PlanRecords[K]> {
  return KINDS[kind].schema;
}

function kindDir(activeRoot: string, initiative: string, kind: PlanKind): string {
  return path.join(activeRoot, initiative, 'plan', KINDS[kind].dir);
}

/** Splits `<initiative>/<suffix>`; null when the id has no initiative prefix or a suffix unfit for a filename. */
function splitId(id: string): { initiative: string; suffix: string } | null {
  const match = /^([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9-]*)$/.exec(id);
  return match === null ? null : { initiative: match[1], suffix: match[2] };
}

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

export async function assertInitiativeExists(activeRoot: string, initiative: string): Promise<void> {
  const stat = await fs.stat(path.join(activeRoot, initiative)).catch(() => null);
  if (!stat?.isDirectory()) throw new NotFoundError(`Initiative not found: ${initiative}`);
}

/** Every record of one kind in one initiative, in filename order; a missing folder holds none. */
export async function loadPlanRecords<K extends PlanKind>(
  activeRoot: string,
  initiative: string,
  kind: K,
): Promise<PlanRecords[K][]> {
  const dir = kindDir(activeRoot, initiative, kind);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((file) => file.endsWith('.yml')).sort();
  } catch (err) {
    if (isMissingFile(err)) return [];
    throw err;
  }
  return Promise.all(files.map((file) => readYaml(path.join(dir, file), KINDS[kind].schema)));
}

/** Records of one kind across every initiative an agent may read; owner-only initiatives are skipped. */
export async function loadVisiblePlanRecords<K extends PlanKind>(
  activeRoot: string,
  kind: K,
): Promise<PlanRecords[K][]> {
  const isVisible = await loadAgentVisibility(activeRoot);
  const slugs = (await listInitiativeSlugsOrEmpty(activeRoot)).filter((slug) => isVisible(slug));
  const perSlug = await Promise.all(slugs.map((slug) => loadPlanRecords(activeRoot, slug, kind)));
  return perSlug.flat();
}

export async function loadPlanRecord<K extends PlanKind>(
  activeRoot: string,
  kind: K,
  id: string,
): Promise<PlanRecords[K]> {
  const notFound = new NotFoundError(`${KINDS[kind].label} not found: ${id}`);
  const parts = splitId(id);
  if (parts === null) throw notFound;
  const file = path.join(kindDir(activeRoot, parts.initiative, kind), `${parts.suffix}.yml`);
  try {
    return await readYaml(file, KINDS[kind].schema);
  } catch (err) {
    if (isMissingFile(err)) throw notFound;
    throw err;
  }
}

export async function planRecordExists(activeRoot: string, kind: PlanKind, id: string): Promise<boolean> {
  try {
    await loadPlanRecord(activeRoot, kind, id);
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}

/** Validates the record, then writes it atomically to the file its id names. */
export async function writePlanRecord<K extends PlanKind>(
  activeRoot: string,
  kind: K,
  record: PlanRecords[K],
): Promise<PlanRecords[K]> {
  const { schema, label } = KINDS[kind];
  const parsed = schema.safeParse(record);
  const parts = splitId(record.id);
  if (!parsed.success) throw new ValidationError(`Invalid ${label.toLowerCase()} ${record.id}: ${parsed.error.message}`);
  if (parts === null) throw new ValidationError(`Invalid ${label.toLowerCase()} id: ${record.id}`);
  const dir = kindDir(activeRoot, parts.initiative, kind);
  await fs.mkdir(dir, { recursive: true });
  await writeYaml(path.join(dir, `${parts.suffix}.yml`), parsed.data, schema);
  return parsed.data;
}

/** Serialises read-modify-write on one initiative's plan folder. */
export async function withPlanLock<T>(activeRoot: string, initiative: string, fn: () => Promise<T>): Promise<T> {
  await assertInitiativeExists(activeRoot, initiative);
  const planDir = path.join(activeRoot, initiative, 'plan');
  await fs.mkdir(planDir, { recursive: true });
  return withFileLock(path.join(planDir, '.lock'), fn);
}

/** The next free `<initiative>/<letter><n>` id, one above the highest number in use. */
export function nextPlanId(initiative: string, letter: string, records: readonly { id: string }[]): string {
  const pattern = new RegExp(`/${letter}(\\d+)$`);
  const used = records.map((record) => Number(pattern.exec(record.id)?.[1] ?? 0));
  return `${initiative}/${letter}${Math.max(0, ...used) + 1}`;
}

/** The bet lookup tasks are checked against: a bet exists when its file is in the plan store, in any state. */
export function planBetLookup(activeRoot: string): BetLookup {
  return { has: (betId) => planRecordExists(activeRoot, 'bet', betId) };
}
