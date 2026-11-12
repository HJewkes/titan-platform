// The weekly Ship batch for tier-2 visual-path gates (TP-4761 S3): a round spec built from the gates pending now.
// Pure and read-only: it resolves no gate and imports no round; the console's Ship does that through `roundShips`.
import type { WorkflowRun } from "@titan-design/workflow";
import type { PendingGate } from "../host.js";
import { visualPathHead } from "./head-moved.js";
import { repoKey } from "./round-merge.js";
import type { HeldAt } from "./round-ship-sweep.js";
import { gateHead } from "./stale-gates.js";

const GATE_TARGET = /^Merge PR #(\d+) in (\S+) at head /;

interface WeekQuestion {
  id: string;
  kind: "pick-one";
  prompt: string;
  options: string[];
  merge: { repo: string; pr: number; headSha: string; ship: string[] };
}

/** One PR's pr-visual read for the packet. Defined here so the batch imports no artifact reader: the evidence informs only. */
export interface RoundVisuals {
  /** The single packet line for this PR: counts, or why no pairs are shown. */
  line: string;
  /** Round-directory paths of the written before and after images, empty when none are shown. */
  variantKeys: string[];
}

/** The owner's context for one PR: the pr-visual packet line, with the pair images it counts. */
interface WeekSection {
  id: string;
  title: string;
  deciding: string;
  context: string;
  questionIds: string[];
  variantKeys: string[];
  seeAlso: string[];
}

interface WeekSkip {
  pr: number;
  reason: string;
}

export interface VisualWeekBatch {
  unit: string;
  round: number;
  questions: WeekQuestion[];
  /** One section per question when pr-visual reads were supplied; absent otherwise. */
  sections?: WeekSection[];
  /** Visual-path gates of the repo left out of this week, each with why; they stay pending and roll into the next. */
  skipped: WeekSkip[];
}

interface VisualWeekInput {
  repo: string;
  gates: readonly PendingGate[];
  runs: readonly WorkflowRun[];
  heldAt: HeldAt;
  now: Date;
  /** The pr-visual read per PR number; a batch built without it carries no sections. */
  visuals?: ReadonlyMap<number, RoundVisuals>;
}

/** ISO 8601 week of the date's UTC day, as `YYYY-Www`. */
export function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

type Candidate = { pr: number; head: string; prompt: string; run: WorkflowRun | undefined };

function candidates(repo: string, gates: readonly PendingGate[], runs: readonly WorkflowRun[]): Candidate[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  return gates.flatMap(({ runId, stepId, gate }) => {
    const match = stepId === "approve-merge" ? GATE_TARGET.exec(gate.prompt) : null;
    const head = gateHead(gate.prompt);
    return match && head && repoKey(match[2]!) === repoKey(repo) ? [{ pr: Number(match[1]), head, prompt: gate.prompt, run: byId.get(runId) }] : [];
  });
}

/** Why a candidate is left out of the batch, or undefined when it is a pending visual-path gate at a current, unheld head. */
function leftOut(repo: string, { pr, head, prompt, run }: Candidate, heldAt: HeldAt): string | undefined {
  if (!run || run.workflowName !== "shepherd-pr" || visualPathHead(run, prompt) !== head) return "not a visual-path gate at the head the run last decided";
  const held = heldAt(repo, pr, head);
  return held === undefined ? undefined : `held: ${held}`;
}

const questionOf = (repo: string, { pr, head }: Candidate): WeekQuestion => ({
  id: `pr-${pr}`,
  kind: "pick-one",
  prompt: `Ship ${repo}#${pr} at ${head.slice(0, 12)}?`,
  options: ["Ship", "Don't ship"],
  merge: { repo, pr, headSha: head, ship: ["Ship"] },
});

const NO_READ = "pr-visual: no before and after shown, the artifact was not read (unattested producer output; not used for the tier)";

function sectionOf({ id, prompt, merge }: WeekQuestion, visual: RoundVisuals | undefined): WeekSection {
  return { id: `s-${id}`, title: `${merge.repo}#${merge.pr}`, deciding: prompt, context: visual?.line ?? NO_READ, questionIds: [id], variantKeys: visual?.variantKeys ?? [], seeAlso: [] };
}

/** One merge-bound question per pending visual-path gate at a current, unheld head, oldest PR first; the gate's own head binds, never the round's. */
export function visualWeekBatch({ repo, gates, runs, heldAt, now, visuals }: VisualWeekInput): VisualWeekBatch {
  const questions: WeekQuestion[] = [];
  const skipped: WeekSkip[] = [];
  for (const candidate of candidates(repo, gates, runs).sort((a, b) => a.pr - b.pr)) {
    const reason = leftOut(repo, candidate, heldAt);
    if (reason !== undefined) skipped.push({ pr: candidate.pr, reason });
    else questions.push(questionOf(repo, candidate));
  }
  const sections = visuals && questions.map((question) => sectionOf(question, visuals.get(question.merge.pr)));
  return { unit: `td-ship-week-${isoWeek(now)}`, round: 1, questions, ...(sections && { sections }), skipped };
}
