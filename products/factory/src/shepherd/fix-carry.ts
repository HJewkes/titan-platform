import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import { HEAD } from "./await-verdict.js";
import { isRepoKey } from "./seats.js";
import {
  BranchName,
  CarryRefusal,
  carryCacheDir,
  carryStateDir,
  ensureCache,
  fetchArgs,
  githubRemote,
  must,
  reasonOf,
  remoteBase,
  serialized,
  systemGit,
  type CarryOptions,
  type Git,
} from "./tree-carry.js";

/** Under the approval-carry family so the step reads as awaiting approval; its own route is the longer match, so the approval record's passthrough never takes it. */
export const FIX_CARRY_STEP = "sh-approval-carry:fix";

const Sha = z.string().regex(HEAD, "must be 40 lowercase hex characters");
const FixInputSchema = z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), baseRef: BranchName, fromHead: Sha, head: Sha });
type FixCarryInput = z.infer<typeof FixInputSchema>;

const FixResultSchema = z.object({
  carries: z.boolean(),
  /** `small-fix` is read only so a result recorded before TP-3070 replays; the consumer never carries on it. */
  rule: z.enum(["merge-up", "small-fix"]).optional(),
  /** The base commit of the head's own history the approved head was merged with. */
  base: z.string().optional(),
  headTree: z.string().optional(),
  /** The tree of `git merge-tree` of the approved head and `base`. */
  mergeTree: z.string().optional(),
  changedLines: z.number().optional(),
  paths: z.array(z.string()).optional(),
  reason: z.string().optional(),
});
export type FixCarryResult = z.infer<typeof FixResultSchema>;

const refuse = (reason: string, rest: Partial<FixCarryResult> = {}): FixCarryResult => ({ ...rest, carries: false, reason });

/** Tree equality over the whole range: any commit of the fixer's own, however small, makes the tree differ from the merge-up's. */
function judge(merged: { base: string; mergeTree: string; headTree: string }): FixCarryResult {
  const facts = { base: merged.base, headTree: merged.headTree, mergeTree: merged.mergeTree };
  if (merged.headTree === merged.mergeTree) return { ...facts, carries: true, rule: "merge-up", changedLines: 0, paths: [] };
  return refuse(`tree of the head differs from the approved head merged onto ${merged.base}`, facts);
}

async function probe(git: Git, dir: string, url: string, input: FixCarryInput, signal?: AbortSignal): Promise<FixCarryResult> {
  await ensureCache(git, dir, signal);
  await must(git, dir, fetchArgs(url, input), signal);
  const ancestry = await git(dir, ["merge-base", "--is-ancestor", input.fromHead, input.head], signal);
  if (ancestry.code === 1) return refuse(`${input.head} does not contain ${input.fromHead}, so it is a rebase, not a fix on top`);
  if (ancestry.code !== 0) throw new CarryRefusal("merge-base", ancestry.code);
  const base = await must(git, dir, ["merge-base", input.head, remoteBase(input.baseRef)], signal);
  const merged = await git(dir, ["merge-tree", "--write-tree", "--no-messages", input.fromHead, base], signal);
  if (merged.code === 1) return refuse(`${input.fromHead} conflicts with ${base}`, { base });
  if (merged.code !== 0) throw new CarryRefusal("merge-tree", merged.code);
  const mergeTree = merged.stdout.trim().split("\n")[0] ?? "";
  const headTree = await must(git, dir, ["rev-parse", `${input.head}^{tree}`], signal);
  return judge({ base, mergeTree, headTree });
}

/**
 * Does `head` differ from the approved `fromHead` merged with the base commit `head` already contains by nothing (a clean
 * merge-up)? A fix of any size asks the owner again (TP-3070). Any failure, from bad input to a refused fetch or an unreadable file, answers no with a reason.
 */
export async function fixCarry(raw: unknown, options: CarryOptions = {}): Promise<FixCarryResult> {
  const parsed = FixInputSchema.safeParse(raw);
  if (!parsed.success) return refuse(`invalid fix-carry input: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const input = parsed.data;
  try {
    const dir = carryCacheDir(carryStateDir(options.stateDir), input.repo);
    const url = (options.remote ?? githubRemote)(input.repo);
    return await serialized(dir, () => probe(options.git ?? systemGit, dir, url, input, options.signal));
  } catch (error) {
    options.signal?.throwIfAborted();
    return refuse(reasonOf(error));
  }
}

export function fixCarryRoute(now: () => number, options: Omit<CarryOptions, "signal"> = {}): StepRoute {
  return codeRoute(FIX_CARRY_STEP, now, (input: unknown, signal) => fixCarry(input, { ...options, signal }));
}

/** The durable probe for one head; a replay reuses the recorded answer, so the ledger shows the tree the owner's answer followed. */
export async function fixCarryStep(ctx: WorkflowContext, input: FixCarryInput): Promise<FixCarryResult> {
  return step(ctx, `${FIX_CARRY_STEP}:${input.head}`, input, FixResultSchema);
}
