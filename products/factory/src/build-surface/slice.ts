import type { StepResult } from "@titan-design/workflow";
import { z } from "zod";
import { DEPLOY_APPROVE } from "./manifest.js";
import { buildRounds, runGates } from "./rounds.js";
import { evidenceDirOf } from "./spec.js";
import * as S from "./schemas.js";
import { cancelRun, commandIn, oneQuestionBrief, sliceAsk, sliceStep, stopSlice, type SliceRun } from "./slice-run.js";

/** What a finished slice hands the outer loop: its merge, so the next wave knows which dependencies are in. */
export const SliceOutcomeSchema = z.object({ slice: z.string(), pr: z.number().int(), head: z.string(), mergeSha: z.string(), deployed: z.boolean() });
export type SliceOutcome = z.infer<typeof SliceOutcomeSchema>;

/** The preflight's exit 10 asks for a fresh extraction, which every slice start already runs, so it proceeds like 0. */
const PREFLIGHT_REEXTRACT = 10;

async function preflight(run: SliceRun): Promise<void> {
  const command = run.spec.preflight;
  if (!command) return;
  const checked = await sliceStep(run, "bs-preflight", undefined, commandIn(run, command.command), S.CommandResultSchema);
  if (!checked.pass && checked.status !== PREFLIGHT_REEXTRACT) stopSlice(run, `blocked: ${checked.detail}`);
}

/** One structured turn, checked by the repo's validator; a rejection is asked again once with the list, then stops the slice. */
async function extractTargets(run: SliceRun): Promise<unknown> {
  const extract = run.slice.extract;
  if (!extract) return undefined;
  let prompt = extract.prompt;
  for (let attempt = 0; ; attempt++) {
    const { targets } = await sliceStep(run, "bs-extract", attempt, { prompt, model: extract.model, maxBudgetUsd: extract.maxBudgetUsd, cwd: run.spec.clone }, S.ExtractSchema);
    const input = { ...commandIn(run, run.spec.validate.targets), payload: targets, builtIn: targets === undefined ? ["no targets"] : [] };
    const verdict = await sliceStep(run, "bs-extract-check", attempt, input, S.ValidationSchema);
    if (verdict.accepted) return targets;
    if (attempt >= 1) stopSlice(run, `targets were rejected twice: ${verdict.rejections.join("; ")}`);
    prompt = `${extract.prompt}\n\nYour last answer was rejected:\n${verdict.rejections.map((line) => `- ${line}`).join("\n")}`;
  }
}

function prBody(run: SliceRun, head: string): string {
  return [`Build-surface slice \`${run.slice.id}\`: ${run.slice.title}.`, "", `Opened by the titan-factory \`build-surface\` workflow (run \`${run.ctx.runId}\`) at head \`${head}\`, after the repo's gates passed at that head.`, `Spend so far: $${run.spentUsd.toFixed(2)}.`].join("\n");
}

/** Waits for Shepherd's merge; a head a fixer moved is gated again before the wait goes on, and a red one stops the slice. */
async function awaitLand(run: SliceRun, pr: number, head: string): Promise<string> {
  for (let wait = 0; ; wait++) {
    const state = await sliceStep(run, "bs-await-land", wait, { repo: run.spec.repo, pr, head }, S.LandStateSchema);
    if (state.state === "merged") return state.mergeSha;
    if (state.state === "stopped") stopSlice(run, `Shepherd stopped PR #${pr}: ${state.reason}`);
    const gates = await runGates(run, `land${wait}`, state.head);
    if (!gates.pass) stopSlice(run, `PR #${pr} moved to ${state.head} and its gates are red there`);
    head = state.head;
  }
}

/** The deploy is the last step; with `approve` set the owner says yes at the merge sha first. A failed deploy stops the whole run. */
async function deploy(run: SliceRun, mergeSha: string): Promise<boolean> {
  const spec = run.spec.deploy;
  if (!spec) return false;
  if (spec.approve) {
    const schema = S.DeployAnswer(mergeSha);
    const options = [{ id: "deploy", label: "Deploy it" }, { id: "skip", label: "Do not deploy this slice" }];
    const brief = oneQuestionBrief(run, `Deploy ${run.spec.repo} slice ${run.slice.id} at merge ${mergeSha.slice(0, 8)}?`, mergeSha, `Deploy merge ${mergeSha}?`, options);
    const answer = schema.parse((await sliceAsk(run, `${DEPLOY_APPROVE}:${run.slice.id}`, `Deploy slice ${run.slice.id} of ${run.spec.repo} at merge ${mergeSha}?`, { schema, brief })).data);
    if (answer.decision === "skip") return false;
  }
  const done = await sliceStep(run, "bs-deploy", undefined, commandIn(run, spec.command, { BS_MERGE_SHA: mergeSha }), S.CommandResultSchema);
  if (!done.pass) cancelRun(run, `slice ${run.slice.id}: the deploy at ${mergeSha} failed: ${done.detail}`);
  return true;
}

/** One `mapItems` item: the whole slice, returned as its last step's result carrying the outcome and the slice's spend. */
export async function runSlice(run: SliceRun): Promise<StepResult> {
  await preflight(run);
  const targets = await extractTargets(run);
  const evidenceDir = evidenceDirOf(run.spec, run.slice.id, "{head}");
  const { green } = await sliceStep(run, "bs-branch", undefined, { repo: run.spec.repo, branch: run.branch, base: run.spec.base, evidenceDir }, S.BranchSchema);
  const head = await buildRounds(run, targets, green);
  const opened = { repo: run.spec.repo, branch: run.branch, base: run.spec.base, title: `${run.slice.title} (${run.slice.id})`, body: prBody(run, head) };
  const { pr } = await sliceStep(run, "bs-pr", undefined, opened, S.PrSchema);
  await sliceStep(run, "bs-shepherd", undefined, { repo: run.spec.repo, pr, task: run.slice.task ?? run.spec.task, implementer: run.agent }, S.RegisteredSchema);
  const mergeSha = await awaitLand(run, pr, head);
  const deployed = await deploy(run, mergeSha);
  const outcome: SliceOutcome = { slice: run.slice.id, pr, head, mergeSha, deployed };
  return { ...run.last!, data: { ...outcome }, usage: { costUsd: run.spentUsd } };
}
