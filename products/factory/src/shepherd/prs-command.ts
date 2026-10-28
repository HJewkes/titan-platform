import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../registry.js";
import { hostPrsSources, shepherdPrs, type PrRow } from "./prs.js";
import { RepoArg, coded } from "./register-args.js";

/** Answers from the snapshot alone: a host with none wired refuses rather than reading GitHub per call. */
export const prsCommand = defineCommand<{ repo?: string }, PrRow[], FactoryContext>({
  name: "shepherd.prs",
  description: "Every open PR of each seat repo (or of --repo) from Shepherd's snapshot, plus the PRs Shepherd merged in the last 24 h, with head, base, run and cached CI; no GitHub call while the list is under a minute old",
  args: z.object({ repo: RepoArg.optional() }),
  result: z.custom<PrRow[]>(),
  async run({ repo }, ctx) {
    const services = ctx.shepherd;
    if (!services) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
    if (!services.snapshot) throw coded("shepherd prs reads the PR snapshot, and this host was opened without one", EXIT.UNAVAILABLE);
    return shepherdPrs(hostPrsSources(ctx.host, services, services.snapshot), repo);
  },
});
