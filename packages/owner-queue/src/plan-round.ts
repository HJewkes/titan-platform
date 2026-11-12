import { isLoopbackUrl, MANIFEST_SCHEMA_ID, RoundSchema, type ManifestInput } from "@titan-design/review-schema";
import { field } from "./rounds.js";

type QuestionInput = ManifestInput["questions"][number];
type SectionInput = NonNullable<ManifestInput["sections"]>[number];

export type PlanGate = "ci-policy" | "skill" | "visual" | "task";

/** A ci-policy approval pins each file the PR changes by its git blob sha; null means the file is absent at head. */
export interface CiPolicyPlanScope {
  ciPolicyKeys: string[];
  files: { path: string; blob: string | null }[];
}

/** A skill or visual approval pins exact paths, not content. */
export interface PathPlanScope {
  paths: string[];
}

/** A task approval validates the task's WHAT: the done_when the owner read, by hash, and the owner-rule reason it needed them. */
export interface TaskPlanScope {
  doneWhenHash: string;
  reason: "new-direction" | "one-way-door" | "new-cap" | "authority-widening";
  visualSignoff: boolean;
}

export type PlanGateScope = { gate: "ci-policy"; scope: CiPolicyPlanScope } | { gate: "skill" | "visual"; scope: PathPlanScope } | { gate: "task"; scope: TaskPlanScope };

/** `title` heads the question's section and `context` is what the owner reads beside the pinned scope. */
export type PlanAsk = PlanGateScope & { title: string; context: string };

/** One `planApprovals` entry: the owner's pick of `approve` on `questionId` records this task, repo, gate and scope. */
export type PlanApproval = { questionId: string; approve: string; task: string; repo: string } & PlanGateScope;

export interface PlanRoundInput {
  unit: string;
  round: number;
  /** A loopback Storybook URL; round@2 requires one even for a questions-only round. Default http://127.0.0.1:6006/. */
  storybookUrl?: string;
  /** Ids of earlier rounds this one replaces. */
  supersedes?: string[];
  task: string;
  repo: string;
  asks: readonly PlanAsk[];
}

/** The round.json the console files: a round@2 manifest plus the console's own `supersedes` and `planApprovals` fields. */
export type PlanRound = ManifestInput & { supersedes?: string[]; planApprovals: PlanApproval[] };

const DEFAULT_STORYBOOK = "http://127.0.0.1:6006/";

interface Rendered {
  question: QuestionInput;
  section: SectionInput;
  binding: PlanApproval;
}

/** The words one question shows: its prompt, its two options and its section's headings. */
interface Words {
  prompt: string;
  approve: string;
  other: string;
  title: string;
  changed: string;
}

/** A task ask validates the task itself, so it reads as one yes-or-not-now on the task's title, not as a pinned change. */
function taskWords(ask: PlanAsk, task: string, questionId: string, used: Set<string>): Words {
  const id = task.slice(task.indexOf("/") + 1);
  return {
    prompt: field(`Validate ${id}: ${ask.title}?`, `Validate ${id}?`, questionId),
    approve: field(`Approve: validate ${task} as described below`, "Approve", questionId, used),
    other: field(`Not now: leave ${task} unvalidated`, "Not now", questionId, used),
    title: field(ask.title, `The task ${task}`, questionId),
    changed: field(`A task that waits for your validation before it is worked: ${task}`, "A task", questionId),
  };
}

function changeWords(ask: PlanAsk, task: string, questionId: string, used: Set<string>): Words {
  const prompt = field(`May the planned ${ask.gate} change for ${task} merge as pinned below?`, "A plan approval", questionId);
  const approve = field(`Approve this ${ask.gate} change for ${task} as pinned below`, "Approve", questionId, used);
  const revise = field(`Revise: send the plan back for ${task}`, "Revise", questionId, used);
  const title = field(ask.title, `The ${ask.gate} plan for ${task}`, questionId);
  return { prompt, approve, other: revise, title, changed: field(`A plan for ${task} that the ${ask.gate} gate would hold at merge`, "A plan", questionId) };
}

/** Labels name the gate and the task, so two asks never share an option and none reads as a blanket sign-off. */
function renderPlanAsk(ask: PlanAsk, input: PlanRoundInput, questionId: string, used: Set<string>): Rendered {
  const { task, repo } = input;
  const { prompt, approve, other, title, changed } = (ask.gate === "task" ? taskWords : changeWords)(ask, task, questionId, used);
  const section: SectionInput = {
    id: `s-${questionId}`,
    title,
    deciding: prompt,
    changed,
    context: field(ask.context, "No further context.", questionId),
    questionIds: [questionId],
  };
  const question: QuestionInput = { id: questionId, kind: "pick-one", prompt, options: [approve, other], signsOff: prompt };
  return { question, section, binding: { questionId, approve, task, repo, ...structuredClone(gateScope(ask)) } };
}

function gateScope(ask: PlanAsk): PlanGateScope {
  if (ask.gate === "ci-policy") return { gate: ask.gate, scope: ask.scope };
  if (ask.gate === "task") return { gate: ask.gate, scope: ask.scope };
  return { gate: ask.gate, scope: ask.scope };
}

/**
 * Turns one PR's predicted WHAT gates into a questions-only round@2 round.json whose `planApprovals` bind each question's
 * approve option to the plan-approval entry the console records (TP-4357). The planner does not recommend its own approval,
 * so no question carries a recommendation. Pure: no I/O and no clock.
 *
 * Throws when `asks` is empty or `storybookUrl` is not loopback, and parses the manifest with RoundSchema before returning.
 */
export function buildPlanRound(input: PlanRoundInput): PlanRound {
  if (input.asks.length === 0) throw new Error("a plan round needs at least one ask");
  const storybookUrl = input.storybookUrl ?? DEFAULT_STORYBOOK;
  if (!isLoopbackUrl(storybookUrl)) throw new Error("storybookUrl must be an http(s) URL on 127.0.0.1, localhost or [::1]");
  const used = new Set<string>();
  const rendered = input.asks.map((ask, index) => renderPlanAsk(ask, input, `q${index + 1}`, used));
  const manifest: ManifestInput = {
    schema: MANIFEST_SCHEMA_ID,
    unit: input.unit,
    round: input.round,
    storybookUrl,
    widths: [1280],
    variants: [],
    questions: rendered.map((each) => each.question),
    sections: rendered.map((each) => each.section),
    recommendations: "shown",
  };
  RoundSchema.parse(manifest);
  const supersedes = input.supersedes === undefined ? {} : { supersedes: [...input.supersedes] };
  return { ...manifest, ...supersedes, planApprovals: rendered.map((each) => each.binding) };
}
