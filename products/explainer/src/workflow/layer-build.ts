import path from "node:path";
import { codeRecordRoute, codeRoute, codeStep, mapItems, type StepResult, type StepRoute, type WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { BuilderRefSchema, LayerBuildSchema, packetKey, type BeatWorker, type BuilderRef, type LayerBuild, type LayerRepair, type LayerRepairer, type RepairRequest } from "../build/beat-worker.js";
import { LayerBuildCache } from "../build/build-cache.js";
import { compileLayer } from "../build/compile-gate.js";
import { buildLayerPacket, type LayerPacket } from "../build/layer-packet.js";
import { layerTreeFiles, writeLayerTree, type BuiltLayer } from "../build/layer-tree.js";
import { claimFacts } from "../claim-facts.js";
import { canonicalJson } from "../eval-store.js";
import type { ResolvedSource } from "../packet.js";
import { ResolvedSchema } from "../resolve-stage.js";
import { ScriptSchema } from "../script-schema.js";
import type { ArtifactStore } from "./artifacts.js";
import { addUsage, NO_USAGE, StageRecordSchema, stepUsage, type StageRecord } from "./records.js";
import { runPaths, writeJson } from "./run-dir.js";
import { StageSpecSchema, type StageSpec } from "./stage-spec.js";

const PACKETS_STEP = "layer-packets";
const BUILD_STEP = "build";
const TREE_STEP = "layer-tree";
const STAGE = "resolve";
export const CUSTOM_LAYERS = "custom-layers";
/** Under the data dir: the cross-run build cache's pointers, by packet key. */
export const LAYER_BUILDS_DIR = "layer-builds";
/** Under a run's dir: one scratch dir per repaired build, by packet key, that the repair agent writes into. */
export const LAYER_REPAIRS_DIR = "layer-repairs";
const BUILD_CONCURRENCY = 4;
// The same input variable `codeStep` uses: an item step needs the whole StepResult, usage included, for the budget.
const INPUT_VAR = "CODE_STEP_INPUT";

/** The step ids `explainer.resolve` dispatches besides its body and checks; the host asserts each has a route. */
export const LAYER_STEP_IDS = [`${PACKETS_STEP}:${STAGE}`, `${BUILD_STEP}:${STAGE}`, `${TREE_STEP}:${STAGE}`] as const;

const BuildItemSchema = z.object({ beatId: z.string(), key: z.string(), json: z.string() });
type BuildItem = z.infer<typeof BuildItemSchema>;
const PacketsSchema = z.object({ items: z.array(BuildItemSchema), notes: z.array(z.string()) });
type Packets = z.infer<typeof PacketsSchema>;
const BuildInputSchema = BuildItemSchema.extend({ builder: BuilderRefSchema });
/** `needsRepair`: the build failed the compile gate, with the error a repair round starts from. `cached`: no worker ran. */
const BuildResultSchema = z.looseObject({
  result: LayerBuildSchema, needsRepair: z.object({ error: z.string() }).optional(), cached: z.literal(true).optional(),
});
const BuiltLayerSchema = z.object({ beatId: z.string(), key: z.string(), build: LayerBuildSchema, cached: z.literal(true).optional() });
const TreeInputSchema = z.object({
  spec: StageSpecSchema,
  body: StageRecordSchema,
  notes: z.array(z.string()),
  built: z.array(BuiltLayerSchema),
  unbuilt: z.array(z.object({ beatId: z.string(), reason: z.string(), build: LayerBuildSchema.optional() })),
});
const PacketsInputSchema = z.object({ spec: StageSpecSchema, body: StageRecordSchema });
// The packet step built this JSON from typed values; the check only refuses a payload that is not a packet at all.
const LayerPacketJson = z.custom<LayerPacket>((value) => z.looseObject({ beat_id: z.string(), spoken: z.string() }).safeParse(value).success);

/**
 * Resolve's custom-layer builds (workflow plan §2.3 stage 6): one `mapItems` item per `layer: "custom"` beat, keyed by
 * its packet and builder, so a replay reuses every build whose packet is unchanged. The tree step then stores the
 * `custom-layers` tree. No custom beats, or a pinned tree, runs no item and no tree step.
 */
export async function buildCustomLayers(ctx: WorkflowContext, spec: StageSpec, body: StageRecord): Promise<StageRecord> {
  const { items, notes } = await codeStep(ctx, `${PACKETS_STEP}:${STAGE}`, { spec, body }, PacketsSchema);
  if (items.length === 0) return { ...body, notes: [...body.notes, ...notes] };
  const builder = spec.config.builder!;
  const mapped = await mapItems(ctx, `${BUILD_STEP}:${STAGE}`, items, (item, stepId) => dispatchBuild(ctx, stepId, item, builder), {
    key: (item) => item.key, concurrency: BUILD_CONCURRENCY, budgetUsd: spec.remainingUsd,
  });
  const outcomes = mapped.results.map(({ item, result }) => ({ item, ...BuildResultSchema.parse(result.data) }));
  const built = outcomes.filter((o) => !o.needsRepair).map(({ item, result, cached }) => ({ beatId: item.beatId, key: item.key, build: result, ...(cached ? { cached } : {}) }));
  const unbuilt = [
    ...outcomes.flatMap(({ item, result, needsRepair }) => (needsRepair ? [{ beatId: item.beatId, reason: `needs repair: ${needsRepair.error}`, build: result }] : [])),
    ...mapped.failed.map(({ item, error }) => ({ beatId: item.beatId, reason: error })),
    ...mapped.skipped.map(({ item }) => ({ beatId: item.beatId, reason: `not launched (${mapped.stoppedBy ?? "stopped"})` })),
  ];
  return codeStep(ctx, `${TREE_STEP}:${STAGE}`, { spec, body, notes, built, unbuilt }, StageRecordSchema);
}

const dispatchBuild = (ctx: WorkflowContext, stepId: string, item: BuildItem, builder: BuilderRef): Promise<StepResult> =>
  ctx.dispatch(stepId, `{{${INPUT_VAR}}}`, { vars: { [INPUT_VAR]: JSON.stringify({ ...item, builder }) }, schema: BuildResultSchema });

/** The run's facts by id, as packet sources; a run with no facts artifact, or one no reader parses, cites none. */
function factSources(text: string | undefined): Map<string, ResolvedSource> {
  const facts = text === undefined ? [] : (claimFacts(text) ?? []);
  return new Map(facts.map((fact) => [fact.id, { id: fact.id, kind: "text" as const, text: typeof fact.text === "string" ? fact.text : JSON.stringify(fact) }]));
}

function packetsFor(spec: StageSpec, body: StageRecord, store: ArtifactStore): Packets {
  if (spec.inputs[CUSTOM_LAYERS] !== undefined) return { items: [], notes: [`${CUSTOM_LAYERS} pinned: no layer builds`] };
  const resolvedSha = body.outputs.resolved;
  if (resolvedSha === undefined) throw new Error("resolve: the body stored no resolved artifact to build custom layers from");
  const custom = ResolvedSchema.parse(JSON.parse(store.readText(resolvedSha))).beats.filter((beat) => beat.layer === "custom");
  if (custom.length === 0) return { items: [], notes: [] };
  const { builder } = spec.config;
  if (!builder) return { items: [], notes: [`custom beats ${custom.map((beat) => beat.id).join(", ")} left unbuilt: no beat worker is configured`] };
  const script = ScriptSchema.parse(JSON.parse(store.readText(spec.inputs.script!)));
  const beats = new Map(script.beats.map((beat) => [beat.id, beat]));
  const facts = factSources(spec.inputs.facts === undefined ? undefined : store.readText(spec.inputs.facts));
  const items = custom.map((resolved) => {
    const { packet, json } = buildLayerPacket({ beat: beats.get(resolved.id)!, resolved, facts });
    return { beatId: resolved.id, key: packetKey(packet, builder), json };
  });
  return { items, notes: [] };
}

interface LayerRouteDeps {
  dataDir: string;
  store: ArtifactStore;
  /** Builds each custom layer; absent, custom beats are left unbuilt with a note. */
  worker?: BeatWorker;
  /** Runs one repair round on a build that fails the compile gate; absent, the build stays marked for repair. */
  repairer?: LayerRepairer;
  signal?: AbortSignal;
}

function workerFor(deps: LayerRouteDeps, beatId: string, builder: BuilderRef): BeatWorker {
  const { worker } = deps;
  if (!worker) throw new Error(`${beatId}: no beat worker is configured to build its custom layer`);
  if (canonicalJson(worker.builder) !== canonicalJson(builder)) {
    throw new Error(`${beatId}: the beat worker is ${canonicalJson(worker.builder)}, but this stage was keyed on ${canonicalJson(builder)}; build a new spec`);
  }
  return worker;
}

/** One item: an earlier run's build of the same packet when the cache has one, else a worker call through the compile gate. */
function buildRoute(deps: LayerRouteDeps): StepRoute {
  const cache = new LayerBuildCache(path.join(deps.dataDir, LAYER_BUILDS_DIR), deps.store);
  return codeRecordRoute(BUILD_STEP, async (raw: z.input<typeof BuildInputSchema>, step) => {
    const { beatId, builder, key, json } = BuildInputSchema.parse(raw);
    const worker = workerFor(deps, beatId, builder);
    const hit = cache.get(key);
    if (hit) return { result: { ...hit, usage: NO_USAGE }, cached: true as const, usage: stepUsage(NO_USAGE) };
    const packet = { packet: LayerPacketJson.parse(JSON.parse(json)), json, bytes: Buffer.byteLength(json) };
    const build: LayerBuild = LayerBuildSchema.parse(await worker.build(packet, deps.signal ? { signal: deps.signal } : {}));
    const verdict = await compileLayer(build.module);
    const scratchDir = path.join(runPaths(deps.dataDir, step.runId).runDir, LAYER_REPAIRS_DIR, key);
    const gated = verdict.ok ? { build } : await repairOnce(deps, { packet, key, module: build.module, error: verdict.error, scratchDir }, build);
    if (gated.error !== undefined) return { result: gated.build, needsRepair: { error: gated.error }, usage: stepUsage(gated.build.usage) };
    cache.put(key, gated.build, { runId: step.runId, stage: STAGE });
    return { result: gated.build, usage: stepUsage(gated.build.usage) };
  });
}

/**
 * One repair round (round caps are TP-2616's), then the compile gate again. Whatever the round spent joins the build's
 * usage, and its session id stays on the build, whether or not the repair passed.
 */
async function repairOnce(deps: LayerRouteDeps, request: RepairRequest, build: LayerBuild): Promise<{ build: LayerBuild; error?: string }> {
  if (!deps.repairer) return { build, error: request.error };
  let repair: LayerRepair;
  try {
    repair = await deps.repairer.repair(request, deps.signal ? { signal: deps.signal } : {});
  } catch (error) {
    return { build, error: `${request.error}; repair not started: ${error instanceof Error ? error.message : String(error)}` };
  }
  const session = repair.sessionId ? ` (repair session ${repair.sessionId})` : "";
  const repaired: LayerBuild = { ...build, ...(repair.module ? { module: repair.module } : {}), usage: addUsage(build.usage, repair.usage), ...(repair.sessionId ? { repairSessionId: repair.sessionId } : {}) };
  if (repair.error !== undefined) return { build: repaired, error: `${request.error}; repair failed${session}: ${repair.error}` };
  if (!repair.module) return { build: repaired, error: `${request.error}; the repair wrote no module${session}` };
  const verdict = await compileLayer(repair.module);
  return verdict.ok ? { build: repaired } : { build: repaired, error: `still fails after repair${session}: ${verdict.error}` };
}

const buildsUsage = (builds: readonly LayerBuild[]) => builds.reduce((sum, build) => addUsage(sum, build.usage), NO_USAGE);

function builtNote(built: readonly (BuiltLayer & { cached?: true })[]): string {
  const cached = built.filter((layer) => layer.cached).length;
  return `${built.length} custom layers built${cached > 0 ? ` (${cached} from the build cache)` : ""}`;
}

/** Stores the `custom-layers` tree; any beat left unbuilt fails the stage, with what every build spent in its record. */
function treeRoute(deps: LayerRouteDeps): StepRoute {
  return codeRecordRoute(TREE_STEP, async (raw: z.input<typeof TreeInputSchema>, step) => {
    const { spec, body, notes, built, unbuilt } = TreeInputSchema.parse(raw);
    const spent = buildsUsage([...built.map((layer) => layer.build), ...unbuilt.flatMap((layer) => layer.build ?? [])]);
    const record: StageRecord = { ...body, usage: addUsage(body.usage, spent), notes: [...body.notes, ...notes] };
    if (unbuilt.length > 0) {
      const message = `resolve: custom layers not built: ${unbuilt.map(({ beatId, reason }) => `${beatId} (${reason})`).join("; ")}`;
      writeJson(runPaths(deps.dataDir, step.runId).failed(STAGE), { ...record, notes: [...record.notes, message] });
      throw new Error(message);
    }
    const dir = path.join(runPaths(deps.dataDir, step.runId).runDir, CUSTOM_LAYERS);
    writeLayerTree(dir, layerTreeFiles(spec.config.builder!, built));
    const sha = deps.store.putTree(dir, CUSTOM_LAYERS, { runId: step.runId, stage: STAGE });
    return { result: { ...record, outputs: { ...record.outputs, [CUSTOM_LAYERS]: sha }, notes: [...record.notes, builtNote(built)] } };
  });
}

/** The routes for resolve's packets, build items and tree steps. */
export function layerRoutes(deps: LayerRouteDeps): StepRoute[] {
  const packets = codeRoute(PACKETS_STEP, async (raw: z.input<typeof PacketsInputSchema>) => {
    const { spec, body } = PacketsInputSchema.parse(raw);
    return packetsFor(spec, body, deps.store);
  });
  return [packets, buildRoute(deps), treeRoute(deps)];
}
