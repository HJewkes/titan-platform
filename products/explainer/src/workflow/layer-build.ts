import path from "node:path";
import { codeRecordRoute, codeRoute, codeStep, mapItems, type StepResult, type StepRoute, type WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { BuilderRefSchema, LayerBuildSchema, packetKey, type BeatWorker, type BuilderRef } from "../build/beat-worker.js";
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
const BuildResultSchema = z.looseObject({ result: LayerBuildSchema });
const BuiltLayerSchema = z.object({ beatId: z.string(), key: z.string(), build: LayerBuildSchema });
const TreeInputSchema = z.object({
  spec: StageSpecSchema,
  body: StageRecordSchema,
  notes: z.array(z.string()),
  built: z.array(BuiltLayerSchema),
  unbuilt: z.array(z.object({ beatId: z.string(), reason: z.string() })),
});
const PacketsInputSchema = z.object({ spec: StageSpecSchema, body: StageRecordSchema });

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
  const built = mapped.results.map(({ item, result }) => ({ beatId: item.beatId, key: item.key, build: BuildResultSchema.parse(result.data).result }));
  const unbuilt = [
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
  signal?: AbortSignal;
}

function buildRoute(deps: LayerRouteDeps): StepRoute {
  return codeRecordRoute(BUILD_STEP, async (raw: z.input<typeof BuildInputSchema>) => {
    const { beatId, builder, json } = BuildInputSchema.parse(raw);
    const { worker } = deps;
    if (!worker) throw new Error(`${beatId}: no beat worker is configured to build its custom layer`);
    if (canonicalJson(worker.builder) !== canonicalJson(builder)) {
      throw new Error(`${beatId}: the beat worker is ${canonicalJson(worker.builder)}, but this stage was keyed on ${canonicalJson(builder)}; build a new spec`);
    }
    const packet = { packet: JSON.parse(json) as LayerPacket, json, bytes: Buffer.byteLength(json) };
    const build = LayerBuildSchema.parse(await worker.build(packet, deps.signal ? { signal: deps.signal } : {}));
    return { result: build, usage: stepUsage(build.usage) };
  });
}

const builtUsage = (built: readonly BuiltLayer[]) => built.reduce((sum, layer) => addUsage(sum, layer.build.usage), NO_USAGE);

/** Stores the `custom-layers` tree; any beat left unbuilt fails the stage, with what the built ones spent in its record. */
function treeRoute(deps: LayerRouteDeps): StepRoute {
  return codeRecordRoute(TREE_STEP, async (raw: z.input<typeof TreeInputSchema>, step) => {
    const { spec, body, notes, built, unbuilt } = TreeInputSchema.parse(raw);
    const record: StageRecord = { ...body, usage: addUsage(body.usage, builtUsage(built)), notes: [...body.notes, ...notes] };
    if (unbuilt.length > 0) {
      const message = `resolve: custom layers not built: ${unbuilt.map(({ beatId, reason }) => `${beatId} (${reason})`).join("; ")}`;
      writeJson(runPaths(deps.dataDir, step.runId).failed(STAGE), { ...record, notes: [...record.notes, message] });
      throw new Error(message);
    }
    const dir = path.join(runPaths(deps.dataDir, step.runId).runDir, CUSTOM_LAYERS);
    writeLayerTree(dir, layerTreeFiles(spec.config.builder!, built));
    const sha = deps.store.putTree(dir, CUSTOM_LAYERS, { runId: step.runId, stage: STAGE });
    return { result: { ...record, outputs: { ...record.outputs, [CUSTOM_LAYERS]: sha }, notes: [...record.notes, `${built.length} custom layers built`] } };
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
