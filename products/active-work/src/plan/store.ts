import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BetLookup } from '@titan-design/pm';
import {
  loadPlanRecords as loadStoredRecords,
  planLabel,
  PlanStoreError,
  readPlanRecord,
  withPlanLock as withStoreLock,
  writePlanRecord as writeStoredRecord,
  type PlanKind,
  type PlanRecords,
} from '@titan-design/pm/node';
import { LockTimeoutError, NotFoundError, ValidationError } from '../errors.js';
import { loadAgentVisibility } from '../sessions/visibility.js';
import { listInitiativeSlugsOrEmpty } from '../sessions/initiatives.js';

/*
 * Planning records (TP-5453 P3) live in pm's plan store, which every plan writer shares; this adapter maps its
 * refusals onto active-work's error kinds and adds the agent-visibility filter.
 */

export { nextPlanId, planSchema } from '@titan-design/pm/node';
export type { PlanKind, PlanRecords } from '@titan-design/pm/node';

function mapped(err: unknown): unknown {
  if (!(err instanceof PlanStoreError)) return err;
  if (err.kind === 'not-found') return new NotFoundError(err.message, { cause: err });
  if (err.kind === 'lock-timeout') return new LockTimeoutError(err.message, { cause: err });
  return new ValidationError(err.message, { cause: err });
}

async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw mapped(err);
  }
}

export async function assertInitiativeExists(activeRoot: string, initiative: string): Promise<void> {
  const stat = await fs.stat(path.join(activeRoot, initiative)).catch(() => null);
  if (!stat?.isDirectory()) throw new NotFoundError(`Initiative not found: ${initiative}`);
}

export function loadPlanRecords<K extends PlanKind>(activeRoot: string, initiative: string, kind: K): Promise<PlanRecords[K][]> {
  return loadStoredRecords(activeRoot, initiative, kind);
}

/** Records of one kind across every initiative an agent may read; owner-only initiatives are skipped. */
export async function loadVisiblePlanRecords<K extends PlanKind>(activeRoot: string, kind: K): Promise<PlanRecords[K][]> {
  const isVisible = await loadAgentVisibility(activeRoot);
  const slugs = (await listInitiativeSlugsOrEmpty(activeRoot)).filter((slug) => isVisible(slug));
  const perSlug = await Promise.all(slugs.map((slug) => loadStoredRecords(activeRoot, slug, kind)));
  return perSlug.flat();
}

export async function loadPlanRecord<K extends PlanKind>(activeRoot: string, kind: K, id: string): Promise<PlanRecords[K]> {
  const record = await readPlanRecord(activeRoot, kind, id);
  if (record === null) throw new NotFoundError(`${planLabel(kind)} not found: ${id}`);
  return record;
}

export async function planRecordExists(activeRoot: string, kind: PlanKind, id: string): Promise<boolean> {
  return (await readPlanRecord(activeRoot, kind, id)) !== null;
}

export function writePlanRecord<K extends PlanKind>(activeRoot: string, kind: K, record: PlanRecords[K]): Promise<PlanRecords[K]> {
  return mapErrors(() => writeStoredRecord(activeRoot, kind, record));
}

/** Serialises read-modify-write on one initiative's plan folder; a missing initiative is NotFound. */
export function withPlanLock<T>(activeRoot: string, initiative: string, fn: () => Promise<T>): Promise<T> {
  return mapErrors(() => withStoreLock(activeRoot, initiative, fn));
}

/** The bet lookup tasks are checked against: a bet exists when its file is in the plan store, in any state. */
export function planBetLookup(activeRoot: string): BetLookup {
  return { has: (betId) => planRecordExists(activeRoot, 'bet', betId) };
}
