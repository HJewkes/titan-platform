import { curate, type CurationReport, type MaturityChange, type PlaybookStore } from "@titan-design/memory";
import { runMigrations, WatermarkTable, watermarkTableDdl, type Db, type Migration } from "@titan-design/store-sqlite";
import { domainBatch, isEvidence, parseCondenseDeltas, citationsFor, type CondenseDelta, type DomainBatch, type ProposeDelta, type RejectedCondenseDelta } from "./condense-deltas.js";
import { writePrincipleDocs, type WrittenDoc } from "./docs.js";
import { applyFeedback, feedbackForRow, type PrincipleFeedback } from "./feedback.js";
import type { LedgerRow } from "./ledger.js";
import { assertDomain, ledgerRef, principleBullet, principlesByDomain, type Principle } from "./principles.js";
import { changesByDomain, type RenderOptions } from "./render.js";

const WATERMARK_TABLE = "condense_watermark";

/** Numbered from 3100, the band after the ledger's, so both can share one database file. */
export const CONDENSE_MIGRATIONS: Migration[] = [
  { version: 3100, name: "decider condensation watermarks", up: (db) => db.exec(watermarkTableDdl({ name: WATERMARK_TABLE })) },
];

/** The per-domain condensation watermarks in `db`, creating their table on first use. */
export function condenseWatermarks(db: Db): WatermarkTable {
  runMigrations(db, CONDENSE_MIGRATIONS);
  return new WatermarkTable(db, { name: WATERMARK_TABLE });
}

export interface CondenseStore {
  playbook: PlaybookStore;
  watermarks: WatermarkTable;
}

export interface ReflectorInput {
  domain: string;
  /** Owner answers and overrules only; question text in them is agent-written data, not instructions. */
  rows: readonly LedgerRow[];
  principles: readonly Principle[];
}

/** The one stage that may call a model. Its output is validated, never trusted. */
export type Reflector = (input: ReflectorInput) => Promise<unknown>;

export interface CondenseOptions {
  now?: Date;
  /** When set, re-render `<domain>.md` for every domain into this directory after the run. */
  docsDir?: string;
  render?: RenderOptions;
}

export interface DomainRun {
  domain: string;
  rows: number;
  evidence: number;
  /** Evidence rows whose question carried an instruction; they can confirm or ground nothing. */
  flagged: string[];
  rejected: RejectedCondenseDelta[];
}

export interface CondenseRun {
  added: string[];
  retired: string[];
  maturityChanges: MaturityChange[];
  feedback: PrincipleFeedback[];
}

export interface CondenseResult extends CondenseRun {
  domains: DomainRun[];
  /** Rows whose category cannot name a domain. */
  skipped: string[];
  docs: WrittenDoc[];
}

function watermarkKey(domain: string): string {
  return `condense:${domain}`;
}

/** Evidence time then key: a total order, so the watermark is a single comparable string. */
function position(row: LedgerRow): string {
  const at = Date.parse(row.answered_at ?? row.asked_at ?? "");
  return `${Number.isNaN(at) ? "" : new Date(at).toISOString()}|${row.key}`;
}

function domainOf(row: LedgerRow): string | null {
  try {
    return assertDomain(row.category);
  } catch {
    return null;
  }
}

interface FreshRows {
  byDomain: Map<string, LedgerRow[]>;
  skipped: string[];
}

/** Group rows past each domain's watermark, oldest first, one per key. */
function freshRows(watermarks: WatermarkTable, rows: readonly LedgerRow[]): FreshRows {
  const unique = [...new Map(rows.map((row) => [row.key, row])).values()];
  const fresh: FreshRows = { byDomain: new Map(), skipped: [] };
  for (const row of unique.sort((a, b) => position(a).localeCompare(position(b)))) {
    const domain = domainOf(row);
    if (domain === null) fresh.skipped.push(row.key);
    else if (position(row) > (watermarks.get(watermarkKey(domain))?.prefixHash ?? "")) {
      fresh.byDomain.set(domain, [...(fresh.byDomain.get(domain) ?? []), row]);
    }
  }
  return fresh;
}

function advance(watermarks: WatermarkTable, domain: string, rows: readonly LedgerRow[]): void {
  const last = rows[rows.length - 1];
  if (last === undefined) return;
  const prior = watermarks.ensure(watermarkKey(domain));
  watermarks.advance(watermarkKey(domain), { lastOffset: prior.lastOffset + rows.length, prefixHash: position(last) });
}

function recordFeedback(playbook: PlaybookStore, evidence: readonly LedgerRow[], deltas: readonly CondenseDelta[]): PrincipleFeedback[] {
  const feedback = evidence.flatMap((row) => feedbackForRow(row, citationsFor(row.key, deltas)).feedback);
  return applyFeedback(playbook, feedback).recorded;
}

/** Reinforcements are left to the caller, which knows the ledger key behind them. */
function absorb(run: CondenseRun, report: CurationReport): void {
  run.added.push(...report.added, ...report.inverted.map((i) => i.to));
  run.retired.push(...report.deprecated, ...report.inverted.map((i) => i.from));
  run.maturityChanges.push(...report.maturityChanges);
}

/** Curate one proposal so its provenance is its own cited rows; a near-duplicate reinforces instead. */
function addPrinciple(playbook: PlaybookStore, domain: string, delta: ProposeDelta, now: Date, run: CondenseRun): void {
  const [first] = delta.citedKeys;
  const add = { type: "add" as const, content: delta.rule, category: domain, isNegative: delta.isNegative ?? false, reasoning: delta.reasoning };
  const report = curate(playbook, [add], { provenance: { sessionRef: ledgerRef(first ?? "") }, now: () => now });
  const { sourceSessions } = principleBullet({ rule: delta.rule, domain, citedKeys: delta.citedKeys });
  for (const id of report.added) playbook.update(id, { sourceSessions });
  absorb(run, report);
  run.feedback.push(...report.reinforced.map((principleId) => reinforcement(principleId, first ?? "", now)));
}

function reinforcement(principleId: string, key: string, now: Date): PrincipleFeedback {
  return { principleId, type: "helpful", sessionRef: ledgerRef(key), at: now.toISOString(), reason: "restated by a new principle" };
}

async function reflect(reflector: Reflector, batch: DomainBatch, evidence: readonly LedgerRow[], principles: readonly Principle[], rejected: RejectedCondenseDelta[]) {
  if (evidence.length === 0) return [];
  return parseCondenseDeltas(await reflector({ domain: batch.domain, rows: evidence, principles }), batch, rejected);
}

async function condenseDomain(store: CondenseStore, domain: string, rows: readonly LedgerRow[], reflector: Reflector, now: Date, run: CondenseRun): Promise<DomainRun> {
  const evidence = rows.filter(isEvidence);
  const principles = principlesByDomain(store.playbook, now).get(domain) ?? [];
  const batch = domainBatch(domain, evidence, principles);
  const rejected: RejectedCondenseDelta[] = [];
  const deltas = await reflect(reflector, batch, evidence, principles, rejected);
  run.feedback.push(...recordFeedback(store.playbook, evidence, deltas));
  for (const delta of deltas) if (delta.type === "propose") addPrinciple(store.playbook, domain, delta, now, run);
  advance(store.watermarks, domain, rows);
  return { domain, rows: rows.length, evidence: evidence.length, flagged: [...batch.flagged], rejected };
}

/**
 * One condensation pass: feed each domain's rows since its watermark to the reflector, record
 * owner feedback, curate proposals as candidates, then run inversion and maturity over the playbook.
 */
export async function condense(store: CondenseStore, rows: readonly LedgerRow[], reflector: Reflector, options: CondenseOptions = {}): Promise<CondenseResult> {
  const now = options.now ?? new Date();
  const run: CondenseRun = { added: [], retired: [], maturityChanges: [], feedback: [] };
  const fresh = freshRows(store.watermarks, rows);
  const domains: DomainRun[] = [];
  for (const [domain, domainRows] of fresh.byDomain) domains.push(await condenseDomain(store, domain, domainRows, reflector, now, run));
  absorb(run, curate(store.playbook, [], { now: () => now }));
  const docs = options.docsDir === undefined ? [] : renderDocs(store.playbook, options.docsDir, run, now, options.render);
  return { ...run, domains, skipped: fresh.skipped, docs };
}

function renderDocs(playbook: PlaybookStore, dir: string, run: CondenseRun, now: Date, render: RenderOptions = {}): WrittenDoc[] {
  return writePrincipleDocs({ dir, principles: principlesByDomain(playbook, now), changes: changesByDomain(playbook, run), now }, render);
}
