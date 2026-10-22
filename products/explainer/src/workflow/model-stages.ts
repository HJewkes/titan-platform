import { tmpdir } from "node:os";
import { z } from "zod";
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
import { loadRuleRegistry, type RuleRegistry } from "../rules.js";
import { addUsage, NO_USAGE, type Check, type StageOutcome, type StageUsage } from "./records.js";

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

/** The guide names the fields in prose only, so the model also gets the exact shape the reply is parsed with. */
const scriptShape = (): string => `## The script/v1 JSON Schema\n\n\`\`\`json\n${JSON.stringify(z.toJSONSchema(ScriptSchema, { io: "input", unrepresentable: "any" }))}\n\`\`\``;

export function scriptPrompt(spine: string, facts: string): string {
  const guide = guidePlan("script", { spine: parseSpine(spine) });
  return [guide, `## Story spine (spine.md)\n\n${spine.trim()}`, `## Facts pack (facts.md)\n\n${facts.trim()}`, scriptShape(), SCRIPT_TASK].join("\n\n") + "\n";
}

const retryPrompt = (prompt: string, error: string): string =>
  `${prompt}\n## Your previous reply was rejected\n\n${error}\n\nReply with the whole corrected object.\n`;

/** Enough issues to fix the reply by, few enough that a reply in the wrong shape does not flood the run error. */
const MAX_ISSUES = 25;
const issueText = (issues: readonly z.core.$ZodIssue[]): string => {
  const shown = issues.slice(0, MAX_ISSUES).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return [...shown, ...(issues.length > MAX_ISSUES ? [`and ${issues.length - MAX_ISSUES} more`] : [])].join("; ");
};

/** The reply's outermost JSON object, so a reply wrapped in a code fence or a sentence still parses. */
function replyObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * The reply is checked here rather than through the CLI's `--json-schema`: that flag refuses the tuple keywords
 * ScriptSchema converts to, and zod refinements (unknown chapters, unspoken cues) never reach a JSON schema anyway.
 */
function checked(outcome: StepRunOutcome): { script?: ScriptV1; error?: string } {
  if (!outcome.ok) return { error: outcome.error };
  let raw: unknown;
  try {
    raw = replyObject(outcome.output);
  } catch {
    return { error: "the reply holds no JSON object" };
  }
  const parsed = ScriptSchema.safeParse(raw);
  if (parsed.success) return { script: parsed.data };
  return { error: issueText(parsed.error.issues) };
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
  /** The L0 checks the repair call answers; all of them by default. */
  l0Checks?: readonly L0Check[];
  signal?: AbortSignal;
}

type Call = (prompt: string) => Promise<StepRunOutcome>;

interface Draft {
  script?: ScriptV1;
  error?: string;
  usage: StageUsage;
  retried: boolean;
}

/** The first call, and one retry naming the schema issues when its reply does not parse. */
async function draftScript(call: Call, prompt: string): Promise<Draft> {
  const first = await call(prompt);
  const result = checked(first);
  if (result.script || !isSchemaFailure(first)) return { ...result, usage: stageUsage(first.usage), retried: false };
  const second = await call(retryPrompt(prompt, result.error ?? ""));
  return { ...checked(second), usage: addUsage(stageUsage(first.usage), stageUsage(second.usage)), retried: true };
}

const failingErrors = (rows: readonly L0Result[]): L0Result[] => rows.filter((row) => row.severity === "error" && !row.pass);

function failureList(rows: readonly L0Result[], rules: RuleRegistry): string {
  const ruleFor = (id: string) => rules.rules.find((rule) => rule.id === id || (rule.l0?.status === "implemented" && rule.l0.checks.includes(id)));
  const where = (row: L0Result) => `beats: ${row.detail_beats.join(", ") || "the whole script"}; measured ${row.value}, needs ${row.threshold}`;
  return rows.map((row) => `- ${row.check_id}: ${ruleFor(row.check_id)?.rule ?? "see the rules above"} (${where(row)})`).join("\n");
}

const repairPrompt = (prompt: string, draft: ScriptV1, failures: string): string =>
  `${prompt}\n## Your draft\n\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\n\n## Checks the draft fails\n\n${failures}\n\nFix what these checks name and keep the rest. Reply with the whole corrected object.\n`;

interface Repair {
  script: ScriptV1;
  usage: StageUsage;
  check: Check;
}

/** One call that answers the draft's failing error-severity L0 rows; its reply is kept only when it parses and fails fewer. */
async function repairScript(call: Call, prompt: string, draft: ScriptV1, lint: (script: ScriptV1) => L0Result[]): Promise<Repair | undefined> {
  const before = failingErrors(lint(draft));
  if (before.length === 0) return undefined;
  const outcome = await call(repairPrompt(prompt, draft, failureList(before, loadRuleRegistry())));
  const repaired = checked(outcome).script;
  const after = repaired ? failingErrors(lint(repaired)).length : before.length;
  const kept = repaired !== undefined && after < before.length;
  const detail = `${before.length} failing error checks before, ${kept ? after : before.length} after${kept ? "" : "; repair not kept"}`;
  return { script: kept ? repaired : draft, usage: stageUsage(outcome.usage), check: { name: "l0-repair", pass: kept && after === 0, detail } };
}

/** One model call from spine and facts to a script/v1 draft, one retry that names schema issues, and one L0 repair call. */
export async function runScriptStage(input: ModelStageInput, deps: ScriptStageDeps): Promise<StageOutcome> {
  const spineText = input.store.readText(need(input, "spine"));
  const prompt = scriptPrompt(spineText, input.store.readText(need(input, "facts")));
  const maxBudgetUsd = Math.max(0.01, Math.min(SCRIPT_CALL_USD, input.remainingUsd));
  const runner = (deps.runnerFor ?? agentRunner)({ cwd: tmpdir(), maxTurns: 1, maxBudgetUsd, defaults: { harness: "claude-print", model: deps.model } });
  const signal = deps.signal ?? new AbortController().signal;
  const call: Call = (text) => runner.run({ runId: input.from.runId, workflowName: "explainer-video", stepId: "script", iteration: 0, prompt: text, signal });
  const draft = await draftScript(call, prompt);
  const retries = draft.retried ? 1 : 0;
  if (!draft.script) throw new StageFailure(`script: ${draft.error}`, draft.usage, retries);
  const spine = parseSpine(spineText);
  const repair = await repairScript(call, prompt, draft.script, (script) => runL0(script, undefined, deps.l0Checks ?? L0_CHECKS, undefined, spine));
  const usage = repair ? addUsage(draft.usage, repair.usage) : draft.usage;
  const checks: Check[] = [{ name: "script-schema", pass: true }, ...(repair ? [repair.check] : [])];
  return { outputs: { draft: putJson(input, repair?.script ?? draft.script, "script") }, usage, retries, checks };
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
