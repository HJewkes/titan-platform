import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../registry.js";
import { RepoArg, coded } from "./register-args.js";
import type { RepoFreeze, RepoFreezes } from "./repo-freeze.js";

const Actor = z.string().min(1).max(100).default("unknown");
const RepoFreezeArgs = z.discriminatedUnion("action", [
  z.object({ action: z.literal("freeze"), repo: RepoArg, reason: z.string().trim().min(1, "a freeze needs a non-empty --reason").max(500), actor: Actor }),
  z.object({ action: z.literal("unfreeze"), repo: RepoArg }),
  z.object({ action: z.literal("list") }),
]);
type RepoFreezeArgs = z.infer<typeof RepoFreezeArgs>;

export interface RepoFreezeResult {
  /** False for a list, or an unfreeze of a repo that was not frozen. */
  changed: boolean;
  /** What happened, in words: an unfreeze that found nothing to lift says so here, never as an error. */
  detail: string;
  freezes: RepoFreeze[];
}

function freezesOf(ctx: FactoryContext): RepoFreezes {
  const freeze = ctx.shepherd?.freeze;
  if (!freeze) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
  return freeze.get().repoFreezes;
}

function runRepoFreeze(args: RepoFreezeArgs, ctx: FactoryContext): RepoFreezeResult {
  const table = freezesOf(ctx);
  if (args.action === "list") return { changed: false, detail: "", freezes: table.list() };
  if (args.action === "freeze") {
    const frozen = table.freeze(args.repo, args.reason, args.actor);
    return { changed: true, detail: `${frozen.repo} is frozen: no Shepherd run merges into it until shepherd unfreeze`, freezes: table.list() };
  }
  const changed = table.unfreeze(args.repo);
  return { changed, detail: changed ? `${args.repo} is unfrozen: waiting runs merge on their next step` : `${args.repo} was not frozen; nothing changed`, freezes: table.list() };
}

/** Not the main-red freeze: `unfreeze` never thaws a red main, and a green main never lifts this freeze. */
export const repoFreezeCommand = defineCommand<RepoFreezeArgs, RepoFreezeResult, FactoryContext>({
  name: "shepherd.freeze",
  description: "Freeze, unfreeze or list coordinator freezes on whole repos: while owner/repo is frozen no Shepherd run merges into it, though runs keep reviewing and CI keeps running",
  args: RepoFreezeArgs,
  result: z.custom<RepoFreezeResult>(),
  run: async (args, ctx) => runRepoFreeze(args, ctx),
});
