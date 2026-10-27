import { defineCommand } from "@titan-design/registry";
import { z } from "zod";
import { EXIT } from "../exit-codes.js";
import type { FactoryContext } from "../registry.js";
import type { MergeBaseException } from "./merge-base-exception.js";
import { PrArg, RepoArg, coded } from "./register-args.js";
import type { ShepherdStore } from "./store.js";

const MergeBaseArgs = z.discriminatedUnion("action", [
  z.object({ action: z.literal("allow"), repo: RepoArg, pr: PrArg, reason: z.string().trim().min(1).max(500), actor: z.string().min(1).max(100).default("unknown") }),
  z.object({ action: z.literal("revoke"), repo: RepoArg, pr: PrArg }),
]);
type MergeBaseArgs = z.infer<typeof MergeBaseArgs>;

export interface MergeBaseResult {
  runId: string;
  /** False for a revoke that found no exception. */
  changed: boolean;
  exception: MergeBaseException | null;
}

function storeOf(ctx: FactoryContext): ShepherdStore {
  if (!ctx.shepherd) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
  return ctx.shepherd.store.get();
}

function runMergeBase(args: MergeBaseArgs, ctx: FactoryContext): MergeBaseResult {
  const store = storeOf(ctx);
  const registration = store.byPr(args.repo, args.pr);
  if (!registration) throw coded(`${args.repo}#${args.pr} is not registered with shepherd, so no run would read the exception`, EXIT.FAILURE);
  const table = store.mergeBaseExceptions();
  const { runId } = registration;
  if (args.action === "revoke") return { runId, changed: table.revoke(runId), exception: null };
  return { runId, changed: true, exception: table.allow({ runId, reason: args.reason, actor: args.actor }) };
}

/** A planner's leave, recorded on the run, for its fix rounds to merge the base when the fix needs code landed there. */
export const mergeBaseCommand = defineCommand<MergeBaseArgs, MergeBaseResult, FactoryContext>({
  name: "shepherd.merge-base",
  description: "Allow or revoke merging the base branch in owner/repo#N's fix rounds: an allowed run's fix-round briefs say the fixer may merge the base, naming who allowed it and why, in place of the line that forbids it",
  args: MergeBaseArgs,
  result: z.custom<MergeBaseResult>(),
  run: async (args, ctx) => runMergeBase(args, ctx),
});
