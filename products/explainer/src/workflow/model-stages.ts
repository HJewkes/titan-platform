import { tmpdir } from "node:os";
import { agentRunner, type AgentRunnerOptions, type LegacyStepRunner, type StepRunOutcome, type StepUsage } from "@titan-design/workflow";
import { L0_CHECKS, l0HardPass, failedChecks, runL0, type L0Check, type L0Result } from "../eval-l0.js";
import { createJudgeHarness, type JudgeConfig, type JudgeHarness } from "../eval-harness.js";
import { guidePlan } from "../guide-plan.js";
import { paceRows } from "../lint-pace.js";
import { fromScriptV1 } from "../pace-items.js";
import { rewriteScript } from "../rewrite-pass.js";
import { ScriptSchema, type ScriptV1 } from "../script-schema.js";
import { parseSpine } from "../spine-schema.js";
import type { ArtifactStore, Provenance } from "./artifacts.js";
import { addUsage, NO_USAGE, type StageOutcome, type StageUsage } from "./records.js";

export type RunnerFor = (options: AgentRunnerOptions) => LegacyStepRunner;
export type HarnessFor = (config: JudgeConfig) => JudgeHarness;

/** One script call's own ceiling; the run's cap also bounds it through `remainingUsd`. */
export const SCRIPT_CALL_USD = 4;

export interface ModelStageInput {
  artifacts: Readonly<Record<string, string>>;
  store: ArtifactStore;
  from: Provenance;
  remainingUsd: number;
}

const need = (input: ModelStageInput, name: string): string => {
  const sha = input.artifacts[name];
  if (sha === undefined) throw new Error(`stage ${input.from.stage} needs artifact "${name}", which no earlier stage produced`);
  return sha;
};

const readScript = (input: ModelStageInput, name: string): ScriptV1 => ScriptSchema.parse(JSON.parse(input.store.readText(need(input, name))));
const putJson = (input: ModelStageInput, value: unknown, kind: string): string => input.store.putText(`${JSON.stringify(value, null, 2)}\n`, kind, input.from);

export function stageUsage(usage: StepUsage | undefined): StageUsage {
  if (!usage) return { ...NO_USAGE, calls: 1, costUnknown: true };
  return {
    usd: usage.costUsd,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    calls: 1,
    ...(usage.costUnknown ? { costUnknown: true as const } : {}),
  };
}

const SCRIPT_TASK = `## Task

Write the whole script/v1 for this video as one JSON object, and reply with that object only.
- Keep every chapter id and beat id, in the order the spine's beat plan lists them, with its function and plannedS.
- Every cue's atCue word must be a word the beat speaks.
- Cite only fact ids from the facts pack, and state no number the facts pack does not hold.
- Set "facts_pack" to "facts.md".`;

export function scriptPrompt(spine: string, facts: string): string {
  const guide = guidePlan("script", { spine: parseSpine(spine) });
  return [guide, `## Story spine (spine.md)\n\n${spine.trim()}`, `## Facts pack (facts.md)\n\n${facts.trim()}`, SCRIPT_TASK].join("\n\n") + "\n";
}

const retryPrompt = (prompt: string, error: string): string =>
  `${prompt}\n## Your previous reply was rejected\n\n${error}\n\nReply with the whole corrected object.\n`;

/** The schema check the runner does not do: zod refinements (unknown chapters, unspoken cues) never reach a JSON schema. */
function checked(outcome: StepRunOutcome): { script?: ScriptV1; error?: string } {
  if (!outcome.ok) return { error: outcome.error };
  let raw: unknown;
  try {
    raw = JSON.parse(outcome.output);
  } catch {
    return { error: "the reply is not JSON" };
  }
  const parsed = ScriptSchema.safeParse(raw);
  if (parsed.success) return { script: parsed.data };
  return { error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ") };
}

const isSchemaFailure = (outcome: StepRunOutcome): boolean => outcome.ok || outcome.code === "schema_invalid";

/** A stage that failed after spending: the route records the spend before the run fails, so the report still shows it. */
export class StageFailure extends Error {
  constructor(message: string, readonly usage: StageUsage, readonly retries = 0) {
    super(message);
    this.name = "StageFailure";
  }
}

export interface ScriptStageDeps {
  model: string;
  runnerFor?: RunnerFor;
  signal?: AbortSignal;
}

/** One model call from spine and facts to a script/v1 draft, plus one retry that names the schema issues. */
export async function runScriptStage(input: ModelStageInput, deps: ScriptStageDeps): Promise<StageOutcome> {
  const prompt = scriptPrompt(input.store.readText(need(input, "spine")), input.store.readText(need(input, "facts")));
  const maxBudgetUsd = Math.max(0.01, Math.min(SCRIPT_CALL_USD, input.remainingUsd));
  const runner = (deps.runnerFor ?? agentRunner)({ cwd: tmpdir(), maxTurns: 1, maxBudgetUsd, defaults: { harness: "claude-print", model: deps.model } });
  const signal = deps.signal ?? new AbortController().signal;
  const call = (text: string) => runner.run({ runId: input.from.runId, workflowName: "explainer-video", stepId: "script", iteration: 0, prompt: text, outputSchema: ScriptSchema, signal });
  let outcome = await call(prompt);
  let usage = stageUsage(outcome.usage);
  let result = checked(outcome);
  const retried = result.script === undefined && isSchemaFailure(outcome);
  if (retried) {
    outcome = await call(retryPrompt(prompt, result.error ?? ""));
    usage = addUsage(usage, stageUsage(outcome.usage));
    result = checked(outcome);
  }
  if (!result.script) throw new StageFailure(`script: ${result.error}`, usage, retried ? 1 : 0);
  return { outputs: { draft: putJson(input, result.script, "script") }, usage, retries: retried ? 1 : 0, checks: [{ name: "script-schema", pass: true }] };
}

export interface RewriteStageDeps {
  judge: JudgeConfig;
  rounds: number;
  harnessFor?: HarnessFor;
}

/** The register rewrite, in process; its spend is the report's own sum over calls. */
export async function runRewriteStage(input: ModelStageInput, deps: RewriteStageDeps): Promise<StageOutcome> {
  const harness = (deps.harnessFor ?? createJudgeHarness)(deps.judge);
  const { script, report } = await rewriteScript(readScript(input, "draft"), { harness, judge: deps.judge, rounds: deps.rounds });
  const failed = report.calls.filter((call) => !call.ok).length;
  const usage: StageUsage = { usd: report.usd, inputTokens: report.tokensIn, outputTokens: report.tokensOut, cacheReadTokens: 0, calls: report.calls.length };
  return {
    outputs: { script: putJson(input, script, "script"), "rewrite-report": putJson(input, report, "rewrite-report") },
    usage,
    retries: failed,
    checks: [{ name: "rewrite-rows", pass: report.after.every((row) => row.pass), detail: `${report.after.filter((row) => !row.pass).length} target rows red` }],
  };
}

const verdict = (name: string, rows: readonly L0Result[]) => ({ name, pass: l0HardPass(rows), detail: `${rows.length} checks; failed: ${failedChecks(rows).join(", ") || "none"}` });

/** L0 with the spine lints, and pace, on the final script. An error-severity failure stops the run here. */
export function runEvalStage(input: ModelStageInput, l0Checks: readonly L0Check[] = L0_CHECKS): StageOutcome {
  const script = readScript(input, "script");
  const spine = parseSpine(input.store.readText(need(input, "spine")));
  const l0 = runL0(script, undefined, l0Checks, undefined, spine);
  const pace = paceRows(fromScriptV1(script), script.video.invariants ?? []);
  const checks = [verdict("l0", l0), verdict("pace", pace)];
  const red = checks.filter((check) => !check.pass);
  if (red.length > 0) throw new Error(`eval: ${red.map((check) => `${check.name} ${check.detail}`).join("; ")}`);
  return { outputs: { l0: putJson(input, { l0, pace }, "eval-rows") }, checks };
}
