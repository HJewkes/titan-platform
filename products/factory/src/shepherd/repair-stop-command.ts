import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../registry.js";
import { parseStopRef, type RepairStop, type RepairStopTarget } from "./repair-stop.js";
import { isRepoKey } from "./seats.js";

const StopRef = z.string().refine((ref) => parseStopRef(ref) !== undefined, "must be owner/repo#N or owner/repo:<path glob>");
const Actor = z.string().min(1).max(100).default("unknown");
const RepairStopArgs = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), ref: StopRef, reason: z.string().trim().min(1).max(500), actor: Actor }),
  z.object({ action: z.literal("clear"), ref: StopRef, actor: Actor }),
  z.object({ action: z.literal("list"), repo: z.string().refine(isRepoKey, "must be owner/repo").optional() }),
]);
type RepairStopArgs = z.infer<typeof RepairStopArgs>;

export interface RepairStopResult {
  /** False for a list, or a clear that found no such stop. */
  changed: boolean;
  stops: RepairStop[];
}

function stopTarget(ref: string, ctx: FactoryContext): RepairStopTarget {
  const parsed = parseStopRef(ref)!;
  const pr = parsed.scope.startsWith("#") ? Number(parsed.scope.slice(1)) : undefined;
  const runId = pr === undefined ? undefined : ctx.shepherd?.store.get().byPr(parsed.repo, pr)?.runId;
  return { ...parsed, ...(runId !== undefined && { runId }) };
}

function runRepairStop(args: RepairStopArgs, ctx: FactoryContext): RepairStopResult {
  if (!ctx.shepherd) throw Object.assign(new Error("shepherd commands need the shepherd routes, and this host was opened without them"), { code: EXIT.UNAVAILABLE });
  const table = ctx.shepherd.store.get().repairStops();
  if (args.action === "list") return { changed: false, stops: table.list(args.repo) };
  const target = stopTarget(args.ref, ctx);
  const changed = args.action === "set" ? (table.set(target, args.reason, { actor: args.actor }), true) : table.clear(target, { actor: args.actor });
  return { changed, stops: table.list(target.repo) };
}

/** Never a hold: a stop gates no merge and lifts none, so `release`, `owner-release` and the g10 self-release are untouched by it. */
export const repairStopCommand = defineCommand<RepairStopArgs, RepairStopResult, FactoryContext>({
  name: "shepherd.repair-stop",
  description: "Set, clear or list a seat's repair stop on owner/repo#N or on owner/repo:<path glob>: while one covers a run, Shepherd wakes and resumes no fixer for it and spends no repair, and its merge path is unchanged",
  args: RepairStopArgs,
  result: z.custom<RepairStopResult>(),
  run: async (args, ctx) => runRepairStop(args, ctx),
});
