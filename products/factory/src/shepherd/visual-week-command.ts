// The read-only batch read behind `titan-factory shepherd visual-week` (TP-4761 S3): it prints the round spec and resolves nothing.
import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../context.js";
import { RepoArg, coded } from "./register-args.js";
import { visualWeekBatch, type VisualWeekBatch } from "./visual-week.js";
import { visualWeekWithVisuals } from "./visual-week-visuals.js";

const VisualWeekArgs = z.object({ repo: RepoArg, images: z.string().min(1).optional() });

export const visualWeekCommand = defineCommand<z.infer<typeof VisualWeekArgs>, VisualWeekBatch, FactoryContext>({
  name: "shepherd.visual-week",
  description: "The weekly Ship batch for owner/repo: one merge-bound question per pending visual-path approve-merge gate at a current, unheld head, as a round spec; resolves no gate. With --images it writes each PR's before and after pairs under that directory and adds a pr-visual line per PR",
  args: VisualWeekArgs,
  result: z.custom<VisualWeekBatch>(),
  run: async ({ repo, images }, ctx) => {
    const services = ctx.shepherd;
    if (!services) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
    const gates = ctx.host.pendingGates();
    const runs = gates.flatMap(({ runId }) => ctx.host.runtime.status(runId) ?? []);
    const heldAt = (heldRepo: string, pr: number, head: string) => services.store.get().heldReason(heldRepo, pr, undefined, head);
    const base = { repo, gates, runs, heldAt, now: new Date() };
    return images === undefined ? visualWeekBatch(base) : visualWeekWithVisuals(base, images);
  },
});
