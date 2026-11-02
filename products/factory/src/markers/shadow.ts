import { isPoolUnavailable } from "@titan-design/github";
import { memoKey, type WorkflowContext } from "@titan-design/workflow";
import { declarationFor, type StepKind, type WorkflowDefinition } from "../definition.js";
import type { PrKey } from "../head-guard/epoch-store.js";
import { isFactEntry, type FactEntry } from "../registry/entry.js";
import { entryFor, type createRegistry } from "../registry/registry.js";
import type { BlobStore } from "./blob-store.js";
import { isSpent, metered, type EntryCounters, type EntryMeter } from "./budget.js";
import { jcs } from "./jcs.js";
import { currentMarker, markerHistory, readMarkerValues, writeMarker, type InputDigest, type MarkerRow } from "./marker-store.js";
import { visit, type EntryLog } from "./orphan-trap.js";
import { itemKey, pinFor, type Pin, type PinSources } from "./pins.js";
import { outputDigest, projectionDigest } from "./projection.js";
import { compareCall, type CompareRow } from "./shadow-diff/compare.js";
import { evaluateFact, versionOf, type ValidityContext, type Verdict } from "./validity.js";

interface ShadowSite {
  runId: string;
  stepId: string;
  fact: string;
  memoKey: string;
}

/** What a marker runner would have done before the call (fast-forward or run), or a shadow failure the run never saw. */
export type ShadowEvent =
  | (ShadowSite & { kind: "verdict"; verdict: Verdict; wouldFastForward: boolean; unreplayable: string[] })
  | (ShadowSite & { kind: "shadow-error"; error: string })
  | (ShadowSite & { kind: "call-site-orphan"; marker: MarkerRow; callSite: string; failClosed: true })
  | (ShadowSite & { kind: "budget-exceeded"; counters: EntryCounters })
  | (ShadowSite & { kind: "entry-end"; counters: EntryCounters })
  | (ShadowSite & { kind: "not-after-skip"; notAfter: string })
  | (ShadowSite & { kind: "advisory" })
  | (ShadowSite & { kind: "compare"; row: CompareRow });

export type ShadowSink = (event: ShadowEvent) => void;

export interface ShadowDeps extends PinSources {
  blobs: BlobStore;
  registry: ReturnType<typeof createRegistry>;
  sink: ShadowSink;
  now: () => string;
  /** The host's injected clock in ms; the budget times shadow work on it, never on wall time. */
  clock: () => number;
  /** Runs with a call-site orphan: the shadow fails closed for them and reports no would-fast-forward. */
  closedRuns: ReadonlySet<string>;
}

/** The workflow whose declarations name each call site, the entry log every call is visited in, and the entry's budget. */
interface ShadowScope {
  definition: WorkflowDefinition;
  log: EntryLog;
  meter: EntryMeter;
}

/** A static call-site id: the workflow and the declared step (family) id, never the iteration. */
const callSiteOf = (definition: WorkflowDefinition, stepId: string): string => `${definition.name}/${declarationFor(definition.steps, stepId)?.id ?? stepId}`;

interface Prepared {
  pin: Exclude<Pin, { unpinnable: string }>;
  inputs: Record<string, InputDigest>;
}

/** What the shadow decided before the live call; `pinned` is absent for an unpinnable step, which writes no marker. */
interface Before {
  verdict: Verdict;
  wouldFastForward: boolean;
  pinned: Prepared | undefined;
  /** The projection of the newest marker at another pin, so a miss that reproduces it counts as `miss-same-output`. */
  previousProjection: string | null;
}

/**
 * Wraps a guarded context so every fact step also computes its verdict and appends its marker beside `step_results`.
 * The live call runs unchanged and its result is returned as the same object: the blob stays authoritative (M1b).
 */
export function shadowContext(ctx: WorkflowContext, deps: ShadowDeps, scope: ShadowScope): WorkflowContext {
  const observe = <R>(op: StepKind, stepId: string, live: () => Promise<R>, outputOf: (result: R) => unknown): Promise<R> =>
    observeCall(ctx, deps, { op, stepId, callSite: callSiteOf(scope.definition, stepId), log: scope.log, meter: scope.meter }, live, outputOf);
  return {
    runId: ctx.runId,
    workflowName: ctx.workflowName,
    signal: ctx.signal,
    param: (key) => ctx.param(key),
    capability: (name) => ctx.capability(name),
    iteration: (stepId) => ctx.iteration(stepId),
    historyNext: () => ctx.historyNext(),
    resumedGate: () => ctx.resumedGate(),
    recoveredInFlight: () => ctx.recoveredInFlight(),
    expireGates: (reason, isStale) => ctx.expireGates(reason, isStale),
    dispatch: (stepId, template, options) => observe("dispatch", stepId, () => ctx.dispatch(stepId, template, options), (result) => result.data),
    seed: (stepId, fn) => observe("seed", stepId, () => ctx.seed(stepId, fn), (result) => result.data),
    assisted: (stepId, prompt, options) => observe("assisted", stepId, () => ctx.assisted(stepId, prompt, options), (result) => result.data),
    authorize: (stepId, request, options) => observe("authorize", stepId, () => ctx.authorize(stepId, request, options), (result) => result),
  };
}

interface ObservedCall {
  op: StepKind;
  stepId: string;
  callSite: string;
  log: EntryLog;
  meter: EntryMeter;
}

async function observeCall<R>(ctx: WorkflowContext, deps: ShadowDeps, call: ObservedCall, live: () => Promise<R>, outputOf: (result: R) => unknown): Promise<R> {
  const key = memoKey(call.op, call.stepId, ctx.iteration(call.stepId));
  const memoHit = call.log.recorded.includes(key);
  if (memoHit) call.meter.counters.replayed += 1;
  visit(call.log, call.callSite, key);
  const entry = entryFor(deps.registry, call.stepId);
  const item = itemOf(ctx);
  if (!entry || !isFactEntry(entry) || !item || isSpent(call.meter)) return live();
  const site: ShadowSite = { runId: ctx.runId, stepId: call.stepId, fact: entry.fact, memoKey: key };
  const exceeded = () => deps.sink({ ...site, kind: "budget-exceeded", counters: { ...call.meter.counters } });
  const shadowed = <T>(work: () => Promise<T> | T) => swallow(deps, site, () => metered(call.meter, deps.clock, exceeded, work));
  const before = await shadowed(() => prepare(deps, entry, item, site, call.meter));
  const prepared = before?.pinned;
  const result = await live();
  if (!isSpent(call.meter)) await shadowed(() => sendCompare(deps, site, { entry, before, liveOutput: outputOf(result), memoHit }));
  if (prepared && !isSpent(call.meter)) await shadowed(() => record(deps, entry, item, { ...site, callSite: call.callSite }, prepared, outputOf(result)));
  return result;
}

/** An unpinnable step or a failed prepare leaves no verdict to compare, so the row is `unmarked`. */
function sendCompare(deps: ShadowDeps, site: ShadowSite, call: { entry: FactEntry; before: Before | undefined; liveOutput: unknown; memoHit: boolean }): void {
  const verdict = call.before?.pinned ? call.before.verdict : undefined;
  const markerProjection = verdict?.status === "valid" ? (verdict.marker?.projectionDigest ?? null) : null;
  const projections = { markerProjection, previousProjection: call.before?.previousProjection ?? null };
  const row = compareCall({ verdict, wouldFastForward: call.before?.wouldFastForward ?? false, ...projections, liveOutput: call.liveOutput, entry: call.entry, memoHit: call.memoHit });
  if (row) deps.sink({ ...site, kind: "compare", row });
}

/** What the shadow does when a `notAfter` step is skipped or runs live (C28). */
export interface NotAfterShadow {
  skipped(stepId: string, notAfter: string): void;
  live(stepId: string, notAfter: string): Promise<void>;
}

/**
 * A skip is a visit, so its call site is never an orphan, and one digest line. A live run of a step whose `notAfter` fact
 * already holds a valid marker is what a marker runner would only advise on, never block.
 */
export function notAfterShadow(ctx: WorkflowContext, deps: ShadowDeps, scope: Pick<ShadowScope, "definition" | "log">): NotAfterShadow {
  const siteOf = (stepId: string, fact: string): ShadowSite => ({ runId: ctx.runId, stepId, fact, memoKey: "" });
  return {
    skipped: (stepId, notAfter) => {
      visit(scope.log, callSiteOf(scope.definition, stepId));
      void swallow(deps, siteOf(stepId, notAfter), () => deps.sink({ ...siteOf(stepId, notAfter), kind: "not-after-skip", notAfter }));
    },
    live: async (stepId, notAfter) => {
      const item = itemOf(ctx);
      if (!item) return;
      const validity: ValidityContext = { registry: deps.registry, sources: deps, now: deps.now() };
      await swallow(deps, siteOf(stepId, notAfter), async () => {
        if ((await evaluateFact(validity, { item, fact: notAfter })).status === "valid") deps.sink({ ...siteOf(stepId, notAfter), kind: "advisory" });
      });
    },
  };
}

/** Runs without a repo and PR param (audit, autoresearch) have no item, so they write no marker (O2). */
export function itemOf(ctx: WorkflowContext): PrKey | undefined {
  const repo = ctx.param("repo");
  const pr = Number(ctx.param("pr"));
  return repo && Number.isSafeInteger(pr) && pr > 0 ? { repo, pr } : undefined;
}

export async function swallow<T>(deps: Pick<ShadowDeps, "sink">, site: ShadowSite, work: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    try {
      deps.sink({ ...site, kind: "shadow-error", error: error instanceof Error ? error.message : String(error) });
    } catch {
      // A sink that throws must not reach the run either.
    }
    return undefined;
  }
}

type Evaluate = (target: { item: PrKey; fact: string }) => Promise<Verdict>;

async function prepare(deps: ShadowDeps, entry: FactEntry, item: PrKey, site: ShadowSite, meter: EntryMeter): Promise<Before> {
  const validity: ValidityContext = { registry: deps.registry, sources: deps, now: deps.now() };
  const evaluate: Evaluate = (target) => {
    meter.counters.evaluations += 1;
    return evaluateFact(validity, target);
  };
  const verdict = await evaluate({ item, fact: entry.fact });
  const unreplayable = verdict.status === "valid" && verdict.marker ? readMarkerValues(deps.db, deps.blobs, verdict.marker.id).missing : [];
  // A valid marker whose blobs were collected is re-run, never fast-forwarded and never parked (TP-3105 plan §5).
  const event = { ...site, kind: "verdict" as const, verdict, wouldFastForward: verdict.status === "valid" && unreplayable.length === 0 && !deps.closedRuns.has(site.runId), unreplayable };
  deps.sink(event);
  const pin = await pinFor(entry.fact, item, deps, validity.now);
  const pinned = "unpinnable" in pin ? undefined : { pin, inputs: await inputDigests(validity, evaluate, entry, item) };
  const previousProjection = pinned ? previousAt(deps, entry.fact, item, pinned.pin.pin) : null;
  return { verdict, wouldFastForward: event.wouldFastForward, pinned, previousProjection };
}

function previousAt(deps: ShadowDeps, fact: string, item: PrKey, pin: string): string | null {
  return markerHistory(deps.db, { item: itemKey(item), fact }).findLast((marker) => marker.pin !== pin)?.projectionDigest ?? null;
}

/** What the step saw of each material input; an input with no valid verdict is left out, so it later reads as changed. */
async function inputDigests(validity: ValidityContext, evaluate: Evaluate, entry: FactEntry, item: PrKey): Promise<Record<string, InputDigest>> {
  const digests: Record<string, InputDigest> = {};
  for (const { fact } of entry.materialInputs) {
    const verdict = await evaluate({ item, fact });
    const pin = await pinFor(fact, item, validity.sources, validity.now);
    if (verdict.status !== "valid" || "unpinnable" in pin || verdict.digests.projection === null) continue;
    const output = verdict.digests.output;
    digests[fact] = output === null ? { pin: pin.pin, projection: verdict.digests.projection } : { pin: pin.pin, projection: verdict.digests.projection, output };
  }
  return digests;
}

/** Appends the marker unless the current row at its identity already says the same, so a replay appends nothing. */
function record(deps: ShadowDeps, entry: FactEntry, item: PrKey, site: ShadowSite & { callSite: string }, prepared: Prepared, output: unknown): void {
  // An `Unavailable` result is no fact: the step learned nothing, so it writes no marker and counts no re-drive (§2.3).
  if (output === undefined || isPoolUnavailable(output)) return;
  const identity = { item: itemKey(item), fact: entry.fact, pinClass: prepared.pin.pinClass, pin: prepared.pin.pin };
  const version = versionOf(entry);
  const projection = projectionDigest(entry, output);
  const current = currentMarker(deps.db, identity);
  const unchanged = current?.version === version && current.projectionDigest === projection && current.outputDigest === outputDigest(output) && jcs(current.inputDigests) === jcs(prepared.inputs);
  if (unchanged) return;
  writeMarker(deps.db, deps.blobs, {
    ...prepared.pin,
    ...identity,
    step: entry.name,
    callSite: site.callSite,
    version,
    inputDigests: prepared.inputs,
    reads: [],
    output: Buffer.from(jcs(output)),
    projectionDigest: projection,
    runId: site.runId,
    memoKey: site.memoKey,
    writtenAt: deps.now(),
  });
}
