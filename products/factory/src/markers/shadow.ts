import { memoKey, type WorkflowContext } from "@titan-design/workflow";
import type { StepKind } from "../definition.js";
import type { PrKey } from "../head-guard/epoch-store.js";
import { isFactEntry, type FactEntry } from "../registry/entry.js";
import { entryFor, type createRegistry } from "../registry/registry.js";
import type { BlobStore } from "./blob-store.js";
import { jcs } from "./jcs.js";
import { currentMarker, readMarkerValues, writeMarker, type InputDigest } from "./marker-store.js";
import { itemKey, pinFor, type Pin, type PinSources } from "./pins.js";
import { outputDigest, projectionDigest } from "./projection.js";
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
  | (ShadowSite & { kind: "shadow-error"; error: string });

export type ShadowSink = (event: ShadowEvent) => void;

export interface ShadowDeps extends PinSources {
  blobs: BlobStore;
  registry: ReturnType<typeof createRegistry>;
  sink: ShadowSink;
  now: () => string;
}

interface Prepared {
  pin: Exclude<Pin, { unpinnable: string }>;
  inputs: Record<string, InputDigest>;
}

/**
 * Wraps a guarded context so every fact step also computes its verdict and appends its marker beside `step_results`.
 * The live call runs unchanged and its result is returned as the same object: the blob stays authoritative (M1b).
 */
export function shadowContext(ctx: WorkflowContext, deps: ShadowDeps): WorkflowContext {
  const observe = <R>(op: StepKind, stepId: string, live: () => Promise<R>, outputOf: (result: R) => unknown): Promise<R> =>
    observeCall(ctx, deps, { op, stepId }, live, outputOf);
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

async function observeCall<R>(ctx: WorkflowContext, deps: ShadowDeps, call: { op: StepKind; stepId: string }, live: () => Promise<R>, outputOf: (result: R) => unknown): Promise<R> {
  const entry = entryFor(deps.registry, call.stepId);
  const item = itemOf(ctx);
  if (!entry || !isFactEntry(entry) || !item) return live();
  const site: ShadowSite = { runId: ctx.runId, stepId: call.stepId, fact: entry.fact, memoKey: memoKey(call.op, call.stepId, ctx.iteration(call.stepId)) };
  const prepared = await swallow(deps, site, () => prepare(deps, entry, item, site));
  const result = await live();
  if (prepared) await swallow(deps, site, () => record(deps, entry, item, { ...site, callSite: ctx.workflowName }, prepared, outputOf(result)));
  return result;
}

/** Runs without a repo and PR param (audit, autoresearch) have no item, so they write no marker (O2). */
function itemOf(ctx: WorkflowContext): PrKey | undefined {
  const repo = ctx.param("repo");
  const pr = Number(ctx.param("pr"));
  return repo && Number.isSafeInteger(pr) && pr > 0 ? { repo, pr } : undefined;
}

async function swallow<T>(deps: ShadowDeps, site: ShadowSite, work: () => Promise<T> | T): Promise<T | undefined> {
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

async function prepare(deps: ShadowDeps, entry: FactEntry, item: PrKey, site: ShadowSite): Promise<Prepared | undefined> {
  const validity: ValidityContext = { registry: deps.registry, sources: deps, now: deps.now() };
  const verdict = await evaluateFact(validity, { item, fact: entry.fact });
  const unreplayable = verdict.status === "valid" && verdict.marker ? readMarkerValues(deps.db, deps.blobs, verdict.marker.id).missing : [];
  // A valid marker whose blobs were collected is re-run, never fast-forwarded and never parked (TP-3105 plan §5).
  deps.sink({ ...site, kind: "verdict", verdict, wouldFastForward: verdict.status === "valid" && unreplayable.length === 0, unreplayable });
  const pin = await pinFor(entry.fact, item, deps, validity.now);
  return "unpinnable" in pin ? undefined : { pin, inputs: await inputDigests(validity, entry, item) };
}

/** What the step saw of each material input; an input with no valid verdict is left out, so it later reads as changed. */
async function inputDigests(validity: ValidityContext, entry: FactEntry, item: PrKey): Promise<Record<string, InputDigest>> {
  const digests: Record<string, InputDigest> = {};
  for (const { fact } of entry.materialInputs) {
    const verdict = await evaluateFact(validity, { item, fact });
    const pin = await pinFor(fact, item, validity.sources, validity.now);
    if (verdict.status !== "valid" || "unpinnable" in pin || verdict.digests.projection === null) continue;
    const output = verdict.digests.output;
    digests[fact] = output === null ? { pin: pin.pin, projection: verdict.digests.projection } : { pin: pin.pin, projection: verdict.digests.projection, output };
  }
  return digests;
}

/** Appends the marker unless the current row at its identity already says the same, so a replay appends nothing. */
function record(deps: ShadowDeps, entry: FactEntry, item: PrKey, site: ShadowSite & { callSite: string }, prepared: Prepared, output: unknown): void {
  if (output === undefined) return;
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
