import { defineCommand } from "@titan-design/registry";
import { z } from "zod";
import { EXIT } from "../exit-codes.js";
import type { FactoryContext } from "../registry.js";
import { PrArg, RepoArg, coded } from "./register-args.js";
import type { ShepherdStore } from "./store.js";
import { WATCH_EVENTS, WatchEventSchema, type PrWatch } from "./watch-list.js";
import { runFinished } from "./watch-rows.js";

const Actor = z.string().min(1).max(100).default("unknown");
const WatchArgs = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("watch"),
    repo: RepoArg,
    pr: PrArg,
    on: z.array(WatchEventSchema).min(1).default([...WATCH_EVENTS]),
    seat: z.string().regex(/^\S+$/, "must be a non-empty name without whitespace").optional(),
    actor: Actor,
  }),
  z.object({ action: z.literal("unwatch"), repo: RepoArg, pr: PrArg }),
  z.object({ action: z.literal("list") }),
]);
type WatchArgs = z.infer<typeof WatchArgs>;

export interface WatchResult {
  /** False for a list, or an unwatch that found no watch. */
  changed: boolean;
  watches: PrWatch[];
}

function storeOf(ctx: FactoryContext): ShepherdStore {
  if (!ctx.shepherd) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
  return ctx.shepherd.store.get();
}

/** Exit 1, not a usage error: the ref is well formed, Shepherd just has no live run for it to report on. */
function watchedRun(ctx: FactoryContext, store: ShepherdStore, repo: string, pr: number): void {
  const registration = store.byPr(repo, pr);
  if (!registration) throw coded(`${repo}#${pr} is not registered with shepherd, so nothing would report on it; register it first`, EXIT.FAILURE);
  const status = ctx.host.runtime.status(registration.runId)?.status;
  if (status !== undefined && runFinished(status)) throw coded(`${repo}#${pr} already finished (run ${registration.runId} is ${status}), so there is nothing left to watch`, EXIT.FAILURE);
}

/** A `--seat` outside the seat book would take a copy no seat reads, so a typo is refused rather than sent nowhere. */
function knownSeat(ctx: FactoryContext, seat: string | undefined): void {
  if (seat === undefined) return;
  const names = ctx.shepherd?.seats().seats.map((entry) => entry.name) ?? [];
  if (!names.includes(seat)) throw coded(`--seat ${seat} is not in the seat book${names.length === 0 ? "" : ` (seats: ${names.join(", ")})`}, so nothing was watched`, EXIT.FAILURE);
}

function runWatch(args: WatchArgs, ctx: FactoryContext): WatchResult {
  const store = storeOf(ctx);
  const table = store.watches();
  if (args.action === "list") return { changed: false, watches: table.list() };
  if (args.action === "unwatch") return { changed: table.clear(args.repo, args.pr), watches: table.list() };
  watchedRun(ctx, store, args.repo, args.pr);
  knownSeat(ctx, args.seat);
  table.set({ repo: args.repo, pr: args.pr, seat: args.seat ?? null, on: [...new Set(args.on)], actor: args.actor });
  return { changed: true, watches: table.list() };
}

/** A watch gates nothing: it only makes the run's named events prompt in the seat digest, until the digest tells its end. */
export const watchCommand = defineCommand<WatchArgs, WatchResult, FactoryContext>({
  name: "shepherd.watch",
  description: "Watch, unwatch or list watches on owner/repo#N: a watched run's merged, stopped or gated event reaches the watching seat in the next settled digest rather than the batch flush, --seat sends that seat a copy while the run's own seat keeps its lines, and the watch drops once a sent digest tells the run's end",
  args: WatchArgs,
  result: z.custom<WatchResult>(),
  run: async (args, ctx) => runWatch(args, ctx),
});
