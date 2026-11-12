import type { WorkflowContext } from "@titan-design/workflow";
import type { WorkflowDefinition } from "../definition.js";
import type { PrKey } from "../head-guard/epoch-store.js";
import { isFactEntry } from "../registry/entry.js";
import { isSpent, metered, newMeter, type EntryBudget, type EntryMeter } from "./budget.js";
import { entryFor } from "../registry/registry.js";
import { markerHistory, type MarkerRow } from "./marker-store.js";
import { findOrphans, type EntryLog } from "./orphan-trap.js";
import { itemKey } from "./pins.js";
import { CARRY_FACT, carriedThisEntry, carryRow, type CarryProbe } from "./shadow-diff/carry-rows.js";
import { itemOf, notAfterShadow, shadowContext, swallow, type NotAfterShadow, type ShadowDeps } from "./shadow.js";
import { evaluateFact, type Verdict } from "./validity.js";

interface EntryDeps extends ShadowDeps {
  closedRuns: Set<string>;
  /** `<run id>#<marker id>` of every orphan this host has sent, so a second drive of the run sends none again. */
  sentOrphans: Set<string>;
  /** The run's memo keys in recording order, read once when the entry begins. */
  recordedOf: (runId: string) => readonly string[];
  /** The run's step_results as they stand when the entry ends. */
  resultsOf: (runId: string) => Record<string, unknown>;
  /** Reads both diff pins of a carried MERGE; absent, every carry row is `pin-differs` with cause `unprobed`. */
  carryProbe?: CarryProbe;
  entryBudget?: EntryBudget;
}

interface Entry {
  ctx: WorkflowContext;
  notAfter: NotAfterShadow;
  /** Runs the orphan trap and the carry pass, then sends `entry-end` once the drive settles; it never rejects, retries or re-drives. */
  end(): Promise<void>;
}

export function beginEntry(ctx: WorkflowContext, definition: WorkflowDefinition, deps: EntryDeps): Entry {
  const log: EntryLog = { runId: ctx.runId, recorded: deps.recordedOf(ctx.runId), visited: new Set(), reached: 0, failClosed: false };
  const meter = newMeter(deps.entryBudget);
  const shadowed = shadowContext(ctx, deps, { definition, log, meter });
  // An entry-level failure names no step.
  const site = { runId: ctx.runId, stepId: "", fact: "", memoKey: "" };
  const end = async (): Promise<void> => {
    void (await swallow(deps, site, () => trapOrphans(ctx, definition, deps, log)));
    await swallow(deps, site, () => carryPass(ctx, deps, log, meter));
    // D-M2-01 measures every entry from these, so they are sent however the entry settled.
    await swallow(deps, site, () => deps.sink({ ...site, kind: "entry-end", counters: { ...meter.counters } }));
  };
  return { ctx: shadowed, notAfter: notAfterShadow(ctx, deps, { definition, log, meter }), end };
}

/** O5: each MERGE Shepherd carried live this entry, against what the diff pin says; one probe failing skips only its own row. */
async function carryPass(ctx: WorkflowContext, deps: EntryDeps, log: EntryLog, meter: EntryMeter): Promise<void> {
  const item = itemOf(ctx);
  if (!item) return;
  for (const carried of carriedThisEntry(deps.resultsOf(ctx.runId), log.recorded)) {
    if (isSpent(meter)) return;
    const site = { runId: ctx.runId, stepId: carried.memoKey, fact: CARRY_FACT, memoKey: `carry:${carried.head}` };
    const exceeded = () => deps.sink({ ...site, kind: "budget-exceeded", counters: { ...meter.counters } });
    await swallow(deps, site, () =>
      metered(meter, deps.clock, exceeded, async () => {
        const probe = deps.carryProbe && (await deps.carryProbe(item, carried.fromHead, carried.head));
        deps.sink({ ...site, kind: "compare", row: carryRow(item, carried, probe) });
      }),
    );
  }
}

/** O3: before M6 the requirement set is the facts the workflow's declared fact steps meet. */
function requirementSet(definition: WorkflowDefinition, deps: EntryDeps): Set<string> {
  const entries = definition.steps.map((step) => entryFor(deps.registry, step.id));
  return new Set(entries.flatMap((entry) => (entry && isFactEntry(entry) ? [entry.fact] : [])));
}

async function trapOrphans(ctx: WorkflowContext, definition: WorkflowDefinition, deps: EntryDeps, log: EntryLog): Promise<void> {
  const item = itemOf(ctx);
  if (!item) return;
  const facts = requirementSet(definition, deps);
  const markers = [...facts].flatMap((fact) => markerHistory(deps.db, { item: itemKey(item), fact }));
  const statuses = await factStatuses(deps, item, new Set(markers.filter((marker) => marker.runId === log.runId).map((marker) => marker.fact)));
  for (const marker of findOrphans(log, markers, facts, (row) => statuses.get(row.fact) ?? "absent")) sendOrphan(deps, log, marker);
}

async function factStatuses(deps: EntryDeps, item: PrKey, facts: ReadonlySet<string>): Promise<Map<string, Verdict["status"]>> {
  const validity = { registry: deps.registry, sources: deps, now: deps.now() };
  const statuses = new Map<string, Verdict["status"]>();
  for (const fact of facts) statuses.set(fact, (await evaluateFact(validity, { item, fact })).status);
  return statuses;
}

function sendOrphan(deps: EntryDeps, log: EntryLog, marker: MarkerRow): void {
  log.failClosed = true;
  deps.closedRuns.add(log.runId);
  const key = `${log.runId}#${marker.id}`;
  if (deps.sentOrphans.has(key)) return;
  deps.sentOrphans.add(key);
  deps.sink({ kind: "call-site-orphan", runId: log.runId, stepId: marker.step, fact: marker.fact, memoKey: marker.memoKey ?? "", marker, callSite: marker.callSite, failClosed: true });
}
