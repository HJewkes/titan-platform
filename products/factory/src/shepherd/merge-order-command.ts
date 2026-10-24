// superseded-at:M3 (D-M3-19: M3's merge queue must carry merge-order.json, TP-3147)
import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../registry.js";
import { blockers, withinTtl, type Reservation } from "./merge-order.js";
import { PrArg, RepoArg, coded } from "./register-args.js";
import type { MergeOrderServices } from "./services.js";
import type { WatchRow } from "./view.js";

const OrderArgs = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), repo: RepoArg.optional() }),
  z.object({ action: z.literal("clear"), repo: RepoArg, pr: PrArg, reason: z.string().trim().min(1, "a clear needs a non-empty --reason").max(500), actor: z.string().min(1).max(100).default("unknown") }),
]);
type OrderArgs = z.infer<typeof OrderArgs>;

/** `live` orders overlapping merges; an expired, ended or switched-off reservation is listed but orders nothing. */
type OrderState = "live" | "expired" | "not driving" | "rule off";

export interface OrderRow {
  repo: string;
  pr: number;
  runId: string;
  headSha: string;
  since: string;
  ageMinutes: number;
  state: OrderState;
  paths: string[];
  /** The PRs this one let land first, while their runs still drive. */
  ahead: number[];
  /** Earlier live overlapping reservations this PR waits behind. */
  behind: number[];
  /** PRs whose merge step last read that it waits behind this reservation. */
  waiting: number[];
}

export interface OrderResult {
  /** The reservation a break-glass clear ended; absent for a list. */
  cleared?: OrderRow;
  reservations: OrderRow[];
}

function servicesOf(ctx: FactoryContext): MergeOrderServices {
  const services = ctx.shepherd?.mergeOrder;
  if (!services) throw coded("shepherd order needs the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
  return services;
}

function stateOf(services: MergeOrderServices, reservation: Reservation): OrderState {
  const rule = services.rules(reservation.repo);
  if (!rule?.enabled) return "rule off";
  if (!services.order().isDriving(reservation.runId)) return "not driving";
  return withinTtl(reservation, rule, services.now()) ? "live" : "expired";
}

/** Reads the store and serve's memory only, never GitHub, so a seat can run it in a loop. */
export function orderRows(services: MergeOrderServices, reservations: readonly Reservation[]): OrderRow[] {
  const order = services.order();
  const now = services.now();
  const prOfRun = new Map(order.driving().map((run) => [run.id, Number(run.params.pr)]));
  const waits = [...services.waits.values()];
  return reservations.map((reservation) => {
    const { repo, pr, runId, headSha, since, paths } = reservation;
    const rule = services.rules(repo);
    const peers = reservations.filter((other) => other.repo === repo);
    const behind = rule?.enabled ? blockers({ repo, runId, paths }, peers, rule, now, (id) => order.isDriving(id)).map((blocker) => blocker.reservation.pr) : [];
    const ahead = reservation.ahead.flatMap((id) => prOfRun.get(id) ?? []);
    const waiting = waits.filter((wait) => wait.repo === repo && wait.behind === pr).map((wait) => wait.pr);
    return { repo, pr, runId, headSha, since, ageMinutes: Math.floor((now - Date.parse(since)) / 60_000), state: stateOf(services, reservation), paths, ahead, behind, waiting };
  });
}

/** Break-glass: ends a reservation by hand, logged as `order-release` with the caller and the reason. */
function clear(services: MergeOrderServices, args: Extract<OrderArgs, { action: "clear" }>): OrderResult {
  const order = services.order();
  const own = order.list(args.repo).find((reservation) => reservation.pr === args.pr);
  if (own === undefined) throw coded(`order clear refused, nothing changed: ${args.repo}#${args.pr} holds no merge-order reservation`, EXIT.DATAERR);
  const [cleared] = orderRows(services, [own]);
  order.release(args.repo, own.runId, { at: new Date(services.now()).toISOString(), actor: args.actor, reason: `cleared by hand: ${args.reason}` });
  return { cleared, reservations: orderRows(services, order.list(args.repo)) };
}

function runOrder(args: OrderArgs, ctx: FactoryContext): OrderResult {
  const services = servicesOf(ctx);
  if (args.action === "clear") return clear(services, args);
  const order = services.order();
  return { reservations: orderRows(services, args.repo === undefined ? order.listAll() : order.list(args.repo)) };
}

export const orderCommand = defineCommand<OrderArgs, OrderResult, FactoryContext>({
  name: "shepherd.order",
  description: "List merge-order reservations, or only owner/repo's, with their age, state, the PRs they wait behind and the PRs waiting behind them; clear ends owner/repo#N's reservation by hand with a --reason, logged with the caller",
  args: OrderArgs,
  result: z.custom<OrderResult>(),
  run: async (args, ctx) => runOrder(args, ctx),
});

/** What a status row adds: the order wait its merge step read last, and the reservation it holds. */
export interface StatusOrder {
  nextAction?: string;
  mergeOrder?: Pick<OrderRow, "since" | "state" | "paths" | "waiting">;
}

export function statusOrder(services: MergeOrderServices | undefined, row: WatchRow): StatusOrder {
  if (services === undefined || row.pr === null) return {};
  const wait = row.phase === "merging" ? services.waits.get(row.runId) : undefined;
  const own = services.order().list(row.repo).find((reservation) => reservation.runId === row.runId);
  const [held] = own === undefined ? [] : orderRows(services, [own]);
  return { ...(wait && { nextAction: wait.reason }), ...(held && { mergeOrder: { since: held.since, state: held.state, paths: held.paths, waiting: held.waiting } }) };
}
