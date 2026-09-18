import { readFile } from "node:fs/promises";
import type { CodeGraphStore } from "../store.js";
import type { SnapshotRow } from "../types.js";
import { runChecks } from "./check.js";
import type { CheckResult, CheckRule } from "./types.js";
import { validateRules, type ValidateRulesOptions } from "./validate.js";

/** A snapshot id, or a ref name resolved to that ref's newest snapshot. */
export type SnapshotSpec = number | string;

export interface CheckSnapshotOptions {
  snapshot: SnapshotSpec;
  rules: readonly CheckRule[];
  baseline?: SnapshotSpec;
}

export interface CheckSnapshotResult {
  snapshot: SnapshotRow;
  baselineSnapshot?: SnapshotRow;
  result: CheckResult;
}

export function resolveSnapshot(store: CodeGraphStore, spec: SnapshotSpec): SnapshotRow {
  if (typeof spec === "number" || /^\d+$/.test(spec)) {
    const snap = store.getSnapshot(Number(spec));
    if (!snap) throw new Error(`no snapshot with id ${spec}`);
    return snap;
  }
  const snap = store.getLatestSnapshotByRef(spec);
  if (!snap) throw new Error(`no snapshot found for ref "${spec}"`);
  return snap;
}

/** Check one snapshot against a rule set, marking violations already present in the baseline as carryover. */
export function checkSnapshot(store: CodeGraphStore, options: CheckSnapshotOptions): CheckSnapshotResult {
  const snapshot = resolveSnapshot(store, options.snapshot);
  const baselineSnapshot = options.baseline !== undefined ? resolveSnapshot(store, options.baseline) : undefined;
  const result = runChecks(store, {
    snapshotId: snapshot.id,
    rules: options.rules,
    baselineSnapshotId: baselineSnapshot?.id,
  });
  return { snapshot, baselineSnapshot, result };
}

/** Read and validate a `check.json` rules file; deprecated aliases heal through `onWarn`. */
export async function loadCheckRules(
  path: string,
  options: ValidateRulesOptions = {},
): Promise<readonly CheckRule[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read rules file at ${path}: ${errorMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${errorMessage(err)}`);
  }
  return validateRules(parsed, options);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
