import type { StepResult, StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { ApprovedSetSchema, setMatch } from "../approved-set.js";
import { stepIdMatches } from "../definition.js";
import { codeRoute, SET_ANSWER_ORIGIN, step } from "../workflows/land.js";
import { HEAD } from "./await-verdict.js";
import type { CarryTarget } from "./carry-merge.js";
import { changedPathsBetween } from "./changed-paths.js";
import type { ShepherdPhases, VisualSetCarry } from "./phases.js";
import type { OwnerGateReason } from "./policy.js";
import { isRepoKey } from "./seats.js";
import type { VisualAcceptRun } from "./visual-accept.js";
import { CarryRefusal, carryCacheDir, carryStateDir, ensureCache, githubRemote, isAncestor, must, reasonOf, serialized, systemGit, type CarryOptions, type Git } from "./tree-carry.js";

/** Under the approval-carry family so the step reads as awaiting approval; like the own-merge-up probe, its route is the longer match. */
export const SET_CARRY_STEP = "sh-approval-carry:set";

const Sha = z.string().regex(HEAD, "must be 40 lowercase hex characters");
const Mode = z.enum(["shadow", "on"]);
const InputSchema = z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), fromHead: Sha, head: Sha, mode: Mode, set: ApprovedSetSchema });
type SetCarryInput = z.infer<typeof InputSchema>;

/** `decision` is set only when the set carries under `on`; a shadow carry records the same proof and the owner is asked. */
const ResultSchema = z.looseObject({ carries: z.boolean(), mode: Mode, reason: z.string().optional(), decision: z.literal("merge").optional(), headSha: z.string().optional() });
type SetCarryResult = z.infer<typeof ResultSchema>;

/** A refusal never carries, so an input that names no mode records as shadow. */
const refuse = (mode: SetCarryInput["mode"], reason: string, paths?: string[]): SetCarryResult => ({ carries: false, mode, reason, ...(paths && { paths }) });

const LS_TREE_ENTRY = /^(\d+) (\w+) ([0-9a-f]{40})\t(.*)$/s;

/** Each set path's object at `head`, from `ls-tree -z`, so no image bytes pass through git's utf8 stdout; an entry that is not a plain 100644 file never equals a blob id. */
async function objectsAt(git: Git, dir: string, head: string, paths: readonly string[], signal?: AbortSignal): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const listed = await git(dir, ["ls-tree", "-z", head, "--", ...paths], signal);
  if (listed.code !== 0) throw new CarryRefusal("ls-tree", listed.code);
  const entries = listed.stdout.split("\0").flatMap((entry) => {
    const match = LS_TREE_ENTRY.exec(entry);
    return match ? [match] : [];
  });
  return new Map(entries.map(([, mode = "", type, id = "", path = ""]) => [path, type === "blob" && mode === "100644" ? id : `${type} ${mode}`]));
}

async function probe(git: Git, dir: string, url: string, { fromHead, head, mode, set }: SetCarryInput, signal?: AbortSignal): Promise<SetCarryResult> {
  await ensureCache(git, dir, signal);
  await must(git, dir, ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", url, fromHead, head], signal);
  if (!(await isAncestor(git, dir, fromHead, head, signal))) return refuse(mode, `${fromHead} is not an ancestor of ${head}`);
  const changed = await changedPathsBetween(git, dir, fromHead, head, signal);
  const atHead = await objectsAt(git, dir, head, [...set.files.map((file) => file.path), ...set.removed], signal);
  const match = setMatch(set, { changed, atHead });
  if (!match.carries) return refuse(mode, match.reason, match.paths);
  const carried = { carries: true, mode, rule: "approved-set", fromHead, headSha: head, proof: { packetSha: set.packetSha, ciRunId: set.ciRunId, changed } };
  return mode === "on" ? { ...carried, decision: "merge" } : carried;
}

/**
 * Does `head` commit exactly the set the owner accepted at `fromHead`: a descendant of it whose diff names only set paths,
 * each file at its accepted blob and each removed path gone? Every failure, from bad input to a refused fetch, answers no.
 */
export async function setCarry(raw: unknown, options: CarryOptions = {}): Promise<SetCarryResult> {
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) return refuse("shadow", "invalid set carry input");
  const input = parsed.data;
  try {
    const dir = carryCacheDir(carryStateDir(options.stateDir), input.repo);
    const url = (options.remote ?? githubRemote)(input.repo);
    return await serialized(dir, () => probe(options.git ?? systemGit, dir, url, input, options.signal));
  } catch (error) {
    options.signal?.throwIfAborted();
    return refuse(input.mode, reasonOf(error));
  }
}

export function setCarryRoute(now: () => number, options: Omit<CarryOptions, "signal"> = {}): StepRoute {
  return codeRoute(SET_CARRY_STEP, now, (input: unknown, signal) => setCarry(input, { ...options, signal }));
}

/** What the run hands the approval wrapper: the set from the recorded gate answer, how to spend it, the visual test and the live flag. */
export interface SetCarry {
  /** The accepted set and the base its red head was judged on. */
  acceptedSet?: () => { set: unknown; base: string | undefined } | undefined;
  spendSet?: () => void;
  isVisual?: (stepId: string, prompt: string) => boolean;
  /** Absent reads as off. */
  setMode?: () => VisualSetCarry;
  /** The run's visual globs; a set-origin approval follows a merge-up only when the base side matches none of them. */
  visualPaths?: () => readonly string[] | undefined;
}

type SetRun = Pick<VisualAcceptRun, "acceptedSet"> & { target: CarryTarget; phases: Pick<ShepherdPhases, "visualSetCarry">; policy: { ownerGateReason?: OwnerGateReason; visualPaths?: string[] } };
type VisualGateTest = (stepId: string, prompt: string, ownerGateReason: OwnerGateReason | undefined) => string | undefined;

/** The run's target, its accepted set, spent by clearing it, and its visual gate test; `isVisualGate` is passed in, since it imports this file's caller. */
export const setCarryOf = (run: SetRun, isVisualGate: VisualGateTest): SetCarry & { target: CarryTarget } => ({
  ...{ target: run.target, acceptedSet: () => run.acceptedSet, spendSet: () => (run.acceptedSet = undefined), setMode: run.phases.visualSetCarry },
  isVisual: (stepId, prompt) => isVisualGate(stepId, prompt, run.policy.ownerGateReason) !== undefined,
  visualPaths: () => run.policy.visualPaths,
});

/**
 * The flag is read only where the run is live, as the visual accept offer reads it: a replay whose next record is this step
 * reuses it, and a record that goes on to any other step, a resumed gate or another step left in flight predates it. Off
 * emits nothing, so the journal stays as it was.
 */
function stepMode(ctx: WorkflowContext, setMode: (() => VisualSetCarry) | undefined): SetCarryInput["mode"] | "recorded" | undefined {
  const next = ctx.historyNext();
  if (next !== undefined) return stepIdMatches(SET_CARRY_STEP, next) ? "recorded" : undefined;
  if (ctx.recoveredInFlight().some((id) => !stepIdMatches(SET_CARRY_STEP, id)) || ctx.resumedGate() !== undefined) return undefined;
  const mode = setMode?.() ?? "off";
  return mode === "off" ? undefined : mode;
}

type SetGate = { stepId: string; prompt: string; head: string; base: string | undefined };

/** The owner answered a visual land gate themself, merge or send-back, so the set never answers for them after it. */
export function spendOnOwnerAnswer(carry: SetCarry, stepId: string, prompt: string): void {
  if (carry.isVisual?.(stepId, prompt)) carry.spendSet?.();
}

/** At a visual land gate of a later head, the merge answer the accepted set gives it; the set is spent once checked, carried or not. */
export async function approvedSetFollow(ctx: WorkflowContext, target: CarryTarget, carry: SetCarry, gate: SetGate): Promise<StepResult | undefined> {
  const accepted = carry.acceptedSet?.();
  const set = ApprovedSetSchema.safeParse(accepted?.set).data;
  // A set judged on one base never answers a gate into another, and a base the red head's read did not record matches none.
  if (!set || accepted?.base === undefined || accepted.base !== gate.base) return undefined;
  if (set.fromHead === gate.head || !carry.isVisual?.(gate.stepId, gate.prompt)) return undefined;
  const mode = stepMode(ctx, carry.setMode);
  if (mode === undefined) return undefined;
  const stepId = `${SET_CARRY_STEP}:${gate.head}`;
  const result = await step(ctx, stepId, { repo: target.repo, fromHead: set.fromHead, head: gate.head, set, ...(mode !== "recorded" && { mode }) }, ResultSchema);
  carry.spendSet?.();
  if (result.decision !== "merge" || result.headSha !== gate.head) return undefined;
  return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: { decision: "merge", headSha: gate.head, origin: SET_ANSWER_ORIGIN } };
}
