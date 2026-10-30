import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import type { QaGate } from "../qa/gate-profile.js";
import type { ArtifactStore } from "../workflow/artifacts.js";
import { stageRecords } from "../workflow/report.js";
import { planOf } from "../workflow/video-runs.js";
import { StageFailure } from "../workflow/stage-failure.js";
import { QaRefused } from "./qa-gate.js";
import { RenderManifestSchema } from "./render-manifest.js";
import { runRenderStage, type RenderEngine } from "./render-stage.js";

/**
 * The real-run smoke (TP-4276 P3): a stored run's voiced inputs rendered in process, twice at one worker count. It
 * passes only on a QA-gated render with no held errors and byte-identical MP4s (plan risk R7). No model is called.
 */

export const SMOKE_WORKERS = 16;

/** What the render stage cannot draw without: a run that reached tts holds all four. */
const REQUIRED = ["script", "resolved", "words", "audio"] as const;
/** Read when the run has them, as the render stage reads them: the owner's pin, resolve's slots, the cited code. */
const OPTIONAL = ["generated-slots", "slots", "code"] as const;

const GateReportSchema = z.object({ errors: z.array(z.object({ kind: z.string(), beat: z.string(), reason: z.string() })) });

interface HeldRow {
  kind: string;
  beat: string;
  reason: string;
}

export interface SmokeResult {
  runId: string;
  workers: number;
  /** The render manifest's `qaGate`, or `refused` when the gate held errors. */
  qaGate: string;
  heldErrors: number;
  held: HeldRow[];
  /** The two renders' MP4 shas, in order; one when the first render was refused. */
  mp4s: string[];
  /** The first render's stored timeline, which the pair sheet cuts frames by. */
  timeline?: string;
  pass: boolean;
}

interface SmokeInput {
  runId: string;
  artifacts: Readonly<Record<string, string>>;
  store: Pick<ArtifactStore, "readText" | "putText" | "putFile" | "putTree" | "materialise">;
  gate: QaGate;
  workers: number;
  /** Where each render's `qa.json` is kept, since the render stage deletes its scratch. */
  keepDir: string;
}

/** Every artifact a stored run holds: its plan's pins, overlaid by what each of its stages wrote. */
export function runArtifacts(run: WorkflowRun): Record<string, string> {
  return stageRecords(run).reduce<Record<string, string>>((acc, record) => ({ ...acc, ...record.outputs }), { ...planOf(run).artifacts });
}

/** The render inputs of a stored run; a run short of one the render needs is refused by name. */
function smokeInputs(runId: string, artifacts: Readonly<Record<string, string>>): Record<string, string> {
  const missing = REQUIRED.filter((name) => artifacts[name] === undefined);
  if (missing.length > 0) throw new Error(`run ${runId} has no ${missing.map((name) => `"${name}"`).join(", ")} artifact, so it never reached tts; the smoke renders a voiced run`);
  const names = [...REQUIRED, ...OPTIONAL].filter((name) => artifacts[name] !== undefined);
  return Object.fromEntries(names.map((name) => [name, artifacts[name]!]));
}

/** The engine with each render's gate report copied to `keepDir/qa-<n>.json`, kept whether the gate passed or held. */
function keepingQa(engine: RenderEngine, keepDir: string): RenderEngine {
  let renders = 0;
  const keep = (outDir: string) => {
    const report = path.join(outDir, "qa.json");
    mkdirSync(keepDir, { recursive: true });
    if (existsSync(report)) copyFileSync(report, path.join(keepDir, `qa-${++renders}.json`));
  };
  return {
    page: engine.page,
    render: async (input) => {
      try {
        return await engine.render(input);
      } finally {
        keep(input.outDir);
      }
    },
  };
}

function heldRows(keepDir: string): HeldRow[] {
  const report = path.join(keepDir, "qa-1.json");
  if (!existsSync(report)) return [];
  return GateReportSchema.parse(JSON.parse(readFileSync(report, "utf8"))).errors.map(({ kind, beat, reason }) => ({ kind, beat, reason }));
}

async function renderOnce(input: SmokeInput, inputs: Record<string, string>, engine: RenderEngine): Promise<Record<string, string>> {
  const stage = { artifacts: inputs, store: input.store, from: { runId: `smoke-${input.runId}`, stage: "render" }, remainingUsd: 0 };
  const outcome = await runRenderStage(stage, { workers: input.workers, twoRun: false, noQa: false, gate: input.gate }, engine);
  return outcome.outputs;
}

/** Renders the run twice; a held error stops it after the first render, with the gate's rows. */
export async function renderSmoke(input: SmokeInput, engine: RenderEngine): Promise<SmokeResult> {
  const inputs = smokeInputs(input.runId, input.artifacts);
  const gated = keepingQa(engine, input.keepDir);
  const base = { runId: input.runId, workers: input.workers };
  let first: Record<string, string>;
  try {
    first = await renderOnce(input, inputs, gated);
  } catch (error) {
    const refusal = error instanceof StageFailure ? error.cause : error;
    if (!(refusal instanceof QaRefused)) throw error;
    return { ...base, qaGate: "refused", heldErrors: refusal.heldErrors, held: heldRows(input.keepDir), mp4s: [], pass: false };
  }
  const second = await renderOnce(input, inputs, gated);
  const { qaGate } = RenderManifestSchema.parse(JSON.parse(input.store.readText(first["render-manifest"]!)));
  const mp4s = [first.mp4!, second.mp4!];
  const pass = qaGate === "passed" && mp4s[0] === mp4s[1];
  return { ...base, qaGate, heldErrors: 0, held: [], mp4s, ...(first.timeline ? { timeline: first.timeline } : {}), pass };
}
