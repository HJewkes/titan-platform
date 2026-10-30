import { fixPacket, implementerBrief, reviewerBrief, type FixFindings } from "./briefs.js";
import { DEVICE_CHECK } from "./manifest.js";
import * as S from "./schemas.js";
import { cancelRun, commandIn, needComponents, oneQuestionBrief, sliceAsk, sliceStep, stopSlice, type SliceRun } from "./slice-run.js";
import { evidenceDirOf, reviewerNameOf } from "./spec.js";

const ReportStep = S.AgentStepSchema(S.ImplementerReportSchema);
const ReviewStep = S.AgentStepSchema(S.ReviewReportSchema);
/** The repo's gate command exits 3 when a gate's own sensitivity proof fails: the gate is broken, not the code. */
const GATE_BROKEN = 3;

/** A rejected report goes back to the same agent once with the rejection list; a second rejection stops the slice. */
async function checkedReport(run: SliceRun, round: number, report: S.ImplementerReport): Promise<S.ImplementerReport> {
  for (let attempt = 0; ; attempt++) {
    if (report.newPrimitivesRequested.length > 0) needComponents(run, report.newPrimitivesRequested);
    const payload = { report, partition: run.slice.partition };
    const input = { ...commandIn(run, run.spec.validate.report, { BS_HEAD: report.head }), payload, builtIn: [], repo: run.spec.repo, branch: run.branch, head: report.head };
    const verdict = await sliceStep(run, "bs-report-check", `${round}:${attempt}`, input, S.ValidationSchema);
    if (verdict.accepted) return report;
    if (attempt >= 1) stopSlice(run, `the report was rejected twice: ${verdict.rejections.join("; ")}`);
    report = await fix(run, `${round}r`, report.head, { rejections: verdict.rejections });
  }
}

async function fix(run: SliceRun, suffix: string, head: string, findings: FixFindings): Promise<S.ImplementerReport> {
  return (await sliceStep(run, "bs-fix", suffix, { name: run.agent, message: fixPacket(head, findings) }, ReportStep)).report;
}

export async function runGates(run: SliceRun, suffix: string, head: string): Promise<S.GateRun> {
  const evidenceDir = evidenceDirOf(run.spec, run.slice.id, head);
  const input = { ...commandIn(run, run.spec.gate.command, { BS_HEAD: head, BS_EVIDENCE: evidenceDir }), head, evidenceDir };
  const gates = await sliceStep(run, "bs-gates", suffix, input, S.GateRunSchema);
  if (gates.exitCode === GATE_BROKEN && ++run.brokenGateRuns >= 2) cancelRun(run, `slice ${run.slice.id}: a gate's sensitivity proof failed twice`);
  return gates;
}

/** Per failing gate, rounds in a row its score did not improve; any gate at the limit stops the slice. */
function trackProgress(run: SliceRun, misses: Map<string, { score?: number; count: number }>, gates: S.GateRun): void {
  for (const gate of gates.gates) {
    const before = misses.get(gate.gate);
    if (gate.pass) misses.delete(gate.gate);
    else if (before && gate.score !== undefined && before.score !== undefined && gate.score > before.score) misses.set(gate.gate, { score: gate.score, count: 1 });
    else misses.set(gate.gate, { ...(gate.score !== undefined && { score: gate.score }), count: (before?.count ?? 0) + 1 });
  }
  const stuck = [...misses].find(([, miss]) => miss.count >= run.spec.noImprovementRounds);
  if (stuck) stopSlice(run, `gate ${stuck[0]} failed ${stuck[1].count} rounds with no score improvement`);
}

/** The preview sync, then once per slice the owner's check on a device, when the spec names a device step. */
async function preview(run: SliceRun, round: number, head: string, asked: { device: boolean }): Promise<{ pass: boolean; detail: string } | undefined> {
  const spec = run.spec.preview;
  if (!spec) return undefined;
  const synced = await sliceStep(run, "bs-preview", round, commandIn(run, spec.command, { BS_HEAD: head }), S.PreviewSchema);
  if (!synced.pass || !spec.deviceStep || asked.device) return synced;
  asked.device = true;
  const schema = S.DeviceAnswer(head);
  const options = [{ id: "pass", label: "It passed on the device" }, { id: "fail", label: "It failed on the device" }];
  const brief = oneQuestionBrief(run, `${run.spec.repo} slice ${run.slice.id} at ${head.slice(0, 8)}: ${spec.deviceStep}`, head, `Did the device step pass at ${head}?`, options);
  const answer = schema.parse((await sliceAsk(run, `${DEVICE_CHECK}:${run.slice.id}`, `On the device, at head ${head}: ${spec.deviceStep}. Did it pass?`, { schema, brief })).data);
  return answer.decision === "pass" ? synced : { pass: false, detail: `device check failed: ${answer.note ?? "no note"}` };
}

/** What the workflow rejects in a review before the repo's validator sees it. */
function reviewProblems(report: S.ReviewReport, head: string): string[] {
  const named = report.rows.some((row) => row.result === "fail" && row.file);
  return [...(report.head === head ? [] : [`reviewed head ${report.head}, not the gated head ${head}`]), ...(report.verdict === "BLOCK" && !named ? ["a BLOCK with no fail row naming a file"] : [])];
}

/** A review whose report fails its validator is asked again once with the rejections; a second rejection stops the slice. */
async function review(run: SliceRun, round: number, head: string): Promise<S.ReviewReport | undefined> {
  const reviewer = run.spec.reviewer;
  if (!reviewer) return undefined;
  let rejections: string[] = [];
  for (let attempt = 0; ; attempt++) {
    const brief = reviewerBrief(run.spec, run.slice, head, rejections);
    const asked = { name: reviewerNameOf(run.spec, run.slice, round), profile: reviewer.profile, cwd: run.spec.clone, brief, task: run.slice.task ?? run.spec.task };
    const { report } = await sliceStep(run, "bs-review", `${round}:${attempt}`, asked, ReviewStep);
    const input = { ...commandIn(run, run.spec.validate.review, { BS_HEAD: head }), payload: report, builtIn: reviewProblems(report, head) };
    const verdict = await sliceStep(run, "bs-review-check", `${round}:${attempt}`, input, S.ValidationSchema);
    if (verdict.accepted) return report;
    if (attempt >= 1) stopSlice(run, `the review was rejected twice: ${verdict.rejections.join("; ")}`);
    rejections = verdict.rejections;
  }
}

async function implement(run: SliceRun, targets: unknown): Promise<string> {
  const task = run.slice.task ?? run.spec.task;
  const brief = implementerBrief(run.spec, run.slice, targets);
  const first = await sliceStep(run, "bs-implement", undefined, { name: run.agent, profile: run.spec.implementer.profile, cwd: run.spec.clone, brief, task }, ReportStep);
  return (await checkedReport(run, 0, first.report)).head;
}

/**
 * Implement, then gates, preview and review at each head, fixing until all pass or a cap stops the slice; returns the green
 * head. A branch already green at its head (`green`) starts there: no implement turn, and round 0 takes its recorded gates.
 */
export async function buildRounds(run: SliceRun, targets: unknown, green?: S.GateRun): Promise<string> {
  let head = green?.head ?? (await implement(run, targets));
  const misses = new Map<string, { score?: number; count: number }>();
  const asked = { device: false };
  for (let round = 0; ; round++) {
    const gates = round === 0 && green ? green : await runGates(run, String(round), head);
    trackProgress(run, misses, gates);
    const previewed = gates.pass ? await preview(run, round, head, asked) : undefined;
    const reviewed = gates.pass && previewed?.pass !== false ? await review(run, round, head) : undefined;
    if (gates.pass && previewed?.pass !== false && reviewed?.verdict !== "BLOCK") return head;
    if (round >= run.spec.maxFixRounds) stopSlice(run, `still failing after ${round} fix rounds`);
    head = (await checkedReport(run, round + 1, await fix(run, String(round + 1), head, { gates, ...(previewed && { preview: previewed }), ...(reviewed && { review: reviewed }) }))).head;
  }
}
