import type { GateRecord } from "@titan-design/hitl";
import { openDatabase } from "@titan-design/store-sqlite";
import type { WorkflowRun } from "@titan-design/workflow";
import { deployCheckoutAncestry, type AncestryProbe } from "../build-ancestry.js";
import type { Verbs } from "../cli-types.js";
import { deployCheckoutFor } from "../cli-service.js";
import { factoryStateDir } from "../config.js";
import { readDeployIncidents } from "../deploy-incident-log.js";
import { EXIT } from "../exit-codes.js";
import { readAllGates } from "../shepherd/owner-friction-read.js";
import { ledgerRuns } from "../shepherd/review-stats.js";
import { isoWeek } from "../shepherd/stats.js";
import { claudeJudge, type AuditJudge } from "./audit-judge.js";
import type { AuditItem } from "./audit-render.js";
import { weekBounds } from "./audit-sample.js";
import { AuditExists, auditPath, buildAudit, writeAuditFile } from "./audit-write.js";

const WEEK_MS = 7 * 86_400_000;

/** What `owner-gates audit` judges, probes ancestry and reads the clock through; each defaults to the real machine. */
export interface OwnerGatesAuditDeps {
  judge?: AuditJudge;
  isAncestor?: AncestryProbe;
  now?: () => number;
}

export interface AuditOpts {
  week?: string;
  dryRun?: boolean;
  force?: boolean;
  /** Commander's `--no-judge`: false skips the model call and every item reads `judge unavailable: disabled`. */
  judge: boolean;
}

/** The last full ISO week before `now`, which the Monday timer audits. */
export const previousWeek = (now: number): string => isoWeek(now - WEEK_MS);

export const auditClock = (verbs: Verbs): number => (verbs.deps.ownerGatesAudit?.now ?? Date.now)();

/** Gates and the runs that could hold their outcomes: a run finishes after its gate resolves, so none before the week matters. */
function readLedger(verbs: Verbs, weekStart: number): { gates: GateRecord[]; runs: WorkflowRun[] } {
  const db = openDatabase(verbs.dbPath(), { readonly: true });
  try {
    return { gates: readAllGates(db), runs: ledgerRuns(db).runs(new Date(weekStart).toISOString()) };
  } finally {
    db.close();
  }
}

/** The production readers TP-2431 records into: the deployer's incident log and ancestry in the deploy checkout. */
function outcomeReaders(verbs: Verbs, opts: AuditOpts) {
  const { env } = verbs.io;
  const injected = verbs.deps.ownerGatesAudit;
  return {
    incidents: readDeployIncidents(factoryStateDir(env)),
    isAncestor: injected?.isAncestor ?? deployCheckoutAncestry(deployCheckoutFor(env)),
    judge: opts.judge ? (injected?.judge ?? claudeJudge(factoryStateDir(env))) : undefined,
  };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function writeOrKeep(verbs: Verbs, week: string, markdown: string, opts: AuditOpts & { keepExisting?: boolean }): boolean {
  const path = auditPath(verbs.io.env, week);
  try {
    writeAuditFile(path, markdown, { force: opts.force });
    verbs.io.stdout(`wrote ${path}\n`);
  } catch (error) {
    if (!(error instanceof AuditExists)) return (verbs.io.stderr(`error: cannot write the audit: ${messageOf(error)}\n`), verbs.setExit(EXIT.FAILURE), false);
    if (!opts.keepExisting) return (verbs.io.stderr(`error: ${error.message}\n`), verbs.setExit(EXIT.FAILURE), false);
    verbs.io.stdout(`kept ${path}; the same week draws the same sample\n`);
  }
  return true;
}

/** Samples `week`, prints or writes the audit, and returns its items; undefined when it could not run. */
export async function runAudit(verbs: Verbs, opts: AuditOpts & { keepExisting?: boolean }, now: number): Promise<AuditItem[] | undefined> {
  const week = opts.week ?? previousWeek(now);
  let ledger: ReturnType<typeof readLedger>;
  try {
    ledger = readLedger(verbs, weekBounds(week).start);
  } catch (error) {
    return (verbs.io.stderr(`error: cannot read the week or the gates: ${messageOf(error)}\n`), verbs.setExit(EXIT.USAGE), undefined);
  }
  const { items, markdown } = await buildAudit({ week, ...ledger, ...outcomeReaders(verbs, opts), now });
  if (opts.dryRun) return (verbs.io.stdout(markdown), items);
  return writeOrKeep(verbs, week, markdown, opts) ? items : undefined;
}
