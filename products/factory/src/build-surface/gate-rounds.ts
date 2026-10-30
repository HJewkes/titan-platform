import { failureGroups, gateRunRoute, type FailureGroup } from "./failure-route.js";
import { INFRA_PARK } from "./manifest.js";
import * as S from "./schemas.js";
import { cancelRun, commandIn, oneQuestionBrief, sliceAsk, sliceStep, stopSlice, type SliceRun } from "./slice-run.js";
import { evidenceDirOf } from "./spec.js";

/** The repo's gate command exits 3 when a gate's own sensitivity proof fails: the gate is broken, not the code. */
const GATE_BROKEN = 3;
const TASK_TAG_ID_CHARS = 16;

const gateNames = (group: FailureGroup): string => group.gates.map((gate) => gate.gate).join(", ");

export async function runGates(run: SliceRun, suffix: string, head: string): Promise<S.GateRun> {
  const evidenceDir = evidenceDirOf(run.spec, run.slice.id, head);
  const input = { ...commandIn(run, run.spec.gate.command, { BS_HEAD: head, BS_EVIDENCE: evidenceDir }), head, evidenceDir };
  const gates = await sliceStep(run, "bs-gates", suffix, input, S.GateRunSchema);
  if (gates.exitCode === GATE_BROKEN && ++run.brokenGateRuns >= 2) cancelRun(run, `slice ${run.slice.id}: a gate's sensitivity proof failed twice`);
  return gates;
}

/** No probe in the spec reads as healthy, so the one retry still happens. */
async function healthy(run: SliceRun, suffix: string, head: string): Promise<boolean> {
  const probe = run.spec.gate.health;
  if (!probe) return true;
  return (await sliceStep(run, "bs-health", suffix, commandIn(run, probe, { BS_HEAD: head }), S.CommandResultSchema)).pass;
}

function failureTask(run: SliceRun, head: string, group: FailureGroup) {
  const [initiative = ""] = (run.slice.task ?? run.spec.task).split("/");
  const tag = `bs-failure:${group.id.slice(0, TASK_TAG_ID_CHARS)}`;
  const fields = {
    title: `build-surface: ${group.class} failure at ${gateNames(group)} in ${run.spec.repo}`,
    severity: "high" as const,
    done_when: `The ${group.class} failure is repaired and slice ${run.slice.id} of ${run.spec.repo} passes ${gateNames(group)}.`,
    tags: [tag],
    notes: [`Slice ${run.slice.id} stopped at head ${head}.`, `Signature: ${group.signature}`, ...group.gates.map((gate) => `${gate.gate}: ${gate.evidence}`)].join("\n"),
  };
  return { initiative, tag, fields };
}

/** One task per failure signature, then the stop; a task that could not be filed is named in the stop rather than failing it. */
async function stopAndFile(run: SliceRun, suffix: string, gates: S.GateRun): Promise<never> {
  const groups = failureGroups(gates, "stop");
  const stops: string[] = [];
  for (const [index, group] of groups.entries()) {
    const filed = await sliceStep(run, "bs-file-task", `${suffix}:${index}`, failureTask(run, gates.head, group), S.FiledTaskSchema);
    stops.push(`${group.class} failure at ${gateNames(group)} (${filed.task ? `filed ${filed.task}` : `no task filed: ${filed.detail}`})`);
  }
  stopSlice(run, stops.join("; "));
}

/** The owner's item for a machine that stayed sick: run the same head's gates again, or stop the slice. */
async function parkForOwner(run: SliceRun, suffix: string, gates: S.GateRun): Promise<void> {
  const { head } = gates;
  const signatures = failureGroups(gates, "retry").map((group) => `${gateNames(group)}: ${group.signature}`).join("; ");
  const options = [{ id: "retry", label: "The machine is fixed; run the gates again" }, { id: "stop", label: "Stop this slice" }];
  const brief = oneQuestionBrief(run, `${run.spec.repo} slice ${run.slice.id} at ${head.slice(0, 8)}: infra failure, ${signatures}`, head, `Run the gates again at ${head}?`, options);
  const schema = S.InfraParkAnswer(head);
  const prompt = `Gates at head ${head} of slice ${run.slice.id} failed on infrastructure after one retry: ${signatures}. Run them again once it is fixed, or stop the slice?`;
  const answer = schema.parse((await sliceAsk(run, `${INFRA_PARK}:${run.slice.id}:${suffix}`, prompt, { schema, brief })).data);
  if (answer.decision === "stop") stopSlice(run, `the owner stopped it on an infra failure: ${signatures}`);
}

/**
 * This round's gate run, routed by each failing record's class. Only a green or `fix` run comes back, so an infra rerun
 * and its park count no fix round and no no-improvement miss; a broken gate or spec stops the slice.
 */
export async function routedGates(run: SliceRun, round: number, head: string): Promise<S.GateRun> {
  let retried = false;
  for (let attempt = 0; ; attempt++) {
    const suffix = attempt === 0 ? String(round) : `${round}:infra${attempt}`;
    const gates = await runGates(run, suffix, head);
    if (gates.pass) return gates;
    const route = gateRunRoute(gates);
    if (route === "fix") return gates;
    if (route === "stop") return stopAndFile(run, suffix, gates);
    if (!retried && (await healthy(run, suffix, head))) {
      retried = true;
      continue;
    }
    await parkForOwner(run, `${round}:${attempt}`, gates);
    retried = false;
  }
}
