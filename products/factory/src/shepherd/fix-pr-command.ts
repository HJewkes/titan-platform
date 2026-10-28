import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../registry.js";
import type { Freeze, FreezeStore } from "./freeze.js";
import { PrArg, RepoArg, coded } from "./register-args.js";
import { supersedeTransientGates } from "./resync.js";
import type { ShepherdServices } from "./services.js";

const FixPrArgs = z.object({
  repo: RepoArg,
  pr: PrArg,
  episode: z.number().int().positive().optional(),
  actor: z.string().min(1).max(100).default("unknown"),
});
type FixPrArgs = z.infer<typeof FixPrArgs>;

export interface FixPrResult {
  repo: string;
  pr: number;
  episode: number;
  redSha: string;
  /** False when this PR was already the episode's fix, so nothing was written. */
  marked: boolean;
  actor: string;
  /** Approve-merge gates a freeze alone held, cancelled so their runs ask the policy again with the mark in place. */
  supersededGates: string[];
}

function servicesOf(ctx: FactoryContext): ShepherdServices & Required<Pick<ShepherdServices, "freeze">> {
  const services = ctx.shepherd;
  if (!services?.freeze) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
  return { ...services, freeze: services.freeze };
}

const refused = (detail: string) => coded(`fix-pr refused, nothing changed: ${detail}`, EXIT.DATAERR);

function openEpisode(freezes: FreezeStore, { repo, episode }: FixPrArgs): Freeze {
  const live = freezes.get(repo);
  if (!live) throw refused(`${repo} has no open main-red freeze`);
  if (episode !== undefined && episode !== live.episode) throw refused(`${repo}'s open main-red episode is ${live.episode}, not ${episode}`);
  return live;
}

/** The mark itself is all the store keeps; a race that ended or took the episode between the read and the write is refused here. */
function mark(freezes: FreezeStore, live: Freeze, args: FixPrArgs, runId: string): boolean {
  const outcome = freezes.markFixPr(args.repo, live.episode, args.pr, args.actor, runId);
  if (outcome === "taken") throw refused(`episode ${live.episode} on ${args.repo} already has fix PR #${freezes.get(args.repo)?.fixPr ?? "?"}`);
  if (outcome === "not-live") throw refused(`episode ${live.episode} on ${args.repo} is no longer open`);
  return outcome === "marked";
}

async function runFixPr(args: FixPrArgs, ctx: FactoryContext): Promise<FixPrResult> {
  const services = servicesOf(ctx);
  const freezes = services.freeze.get();
  const live = openEpisode(freezes, args);
  const registration = services.store.get().byPr(args.repo, args.pr);
  if (!registration) throw refused(`${args.repo}#${args.pr} is not registered with shepherd`);
  const marked = mark(freezes, live, args, registration.runId);
  const superseded = await supersedeTransientGates(ctx.host, services, { repo: args.repo });
  return { repo: args.repo, pr: args.pr, episode: live.episode, redSha: live.redSha, marked, actor: args.actor, supersededGates: superseded.map((gate) => gate.gateId) };
}

/** A seat's way to name the PR that fixes a red main when it is not the auto-fixer's own; the freeze stays for every other PR. */
export const fixPrCommand = defineCommand<FixPrArgs, FixPrResult, FactoryContext>({
  name: "shepherd.fix-pr",
  description: "Mark registered owner/repo#pr as the fix PR of the repo's open main-red freeze episode (--episode, when given, must be it), so its merge passes the freeze while every other PR stays held; one fix PR per episode, recorded with the caller",
  args: FixPrArgs,
  result: z.custom<FixPrResult>(),
  run: runFixPr,
});
