import type { WorkflowContext } from "@titan-design/workflow";
import type { WorkflowDefinition } from "../definition.js";
import type { PrKey } from "../head-guard/epoch-store.js";
import { isFactEntry } from "../registry/entry.js";
import { newMeter, type EntryBudget } from "./budget.js";
import { entryFor } from "../registry/registry.js";
import { markerHistory, type MarkerRow } from "./marker-store.js";
import { findOrphans, type EntryLog } from "./orphan-trap.js";
import { itemKey } from "./pins.js";
import { itemOf, shadowContext, swallow, type ShadowDeps } from "./shadow.js";
import { evaluateFact, type Verdict } from "./validity.js";

interface EntryDeps extends ShadowDeps {
  closedRuns: Set<string>;
  /** `<run id>#<marker id>` of every orphan this host has sent, so a second drive of the run sends none again. */
  sentOrphans: Set<string>;
  /** The run's memo keys in recording order, read once when the entry begins. */
  recordedOf: (runId: string) => readonly string[];
  entryBudget?: EntryBudget;
}

interface Entry {
  ctx: WorkflowContext;
  /** Runs the orphan trap and sends `entry-end` once the drive settles; it never rejects, retries or re-drives. */
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
    // D-M2-01 measures every entry from these, so they are sent however the entry settled.
    await swallow(deps, site, () => deps.sink({ ...site, kind: "entry-end", counters: { ...meter.counters } }));
  };
  return { ctx: shadowed, end };
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
