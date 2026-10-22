import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../registry.js";
import { failureOf } from "./error-class.js";
import { repoRedSeat } from "./main-watch.js";
import { RepoArg, coded } from "./register-args.js";
import type { ShepherdServices } from "./services.js";
import { closeThawedMainGates, type ClosedMainGate } from "./thawed-main-gates.js";

const ThawArgs = z.object({
  repo: RepoArg,
  redSha: z.string().regex(/^[0-9a-f]{40}$/i, "--red-sha must be the episode's full 40-character red sha"),
  reason: z.string().trim().min(1, "a thaw needs a non-empty --reason").max(500),
  actor: z.string().min(1).max(100).default("unknown"),
});
type ThawArgs = z.infer<typeof ThawArgs>;

/** Whether the thaw's alert reached a seat; a failed alert never undoes the thaw. */
export interface ThawAlert {
  seat: string | null;
  sent: boolean;
  detail: string;
}

export interface ThawResult {
  repo: string;
  episode: number;
  redSha: string;
  actor: string;
  /** Left open: the thaw ends the freeze, not the work of fixing main. */
  fixTask: string | null;
  closedGates: ClosedMainGate[];
  alert: ThawAlert;
}

function servicesOf(ctx: FactoryContext): ShepherdServices & Required<Pick<ShepherdServices, "freeze">> {
  const services = ctx.shepherd;
  if (!services?.freeze) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
  return { ...services, freeze: services.freeze };
}

const alertText = ({ repo, redSha, actor, reason }: ThawArgs, episode: number): string =>
  [`Shepherd: ${actor} thawed main-red freeze episode ${episode} on ${repo} by hand at red sha ${redSha}.`, `Reason: ${reason}`, "Main may still be red there; the episode's fix task stays open."].join("\n");

/** Never throws: an unreachable seat is logged as an error line and reported, and the thaw stands. */
async function alertThaw(services: ShepherdServices, args: ThawArgs, episode: number): Promise<ThawAlert> {
  const unsent = (seat: string | null, detail: string): ThawAlert => {
    console.error(`shepherd: the hand thaw of ${args.repo} at ${args.redSha} by ${args.actor} alerted no seat: ${detail}`);
    return { seat, sent: false, detail };
  };
  const ports = services.thawAlert;
  if (!ports) return unsent(null, "no agent-chat is configured to send it");
  let seat: string | undefined;
  try {
    seat = await repoRedSeat(services.seats(), args.repo, ports);
    if (seat === undefined) return unsent(null, "no red seat, run seat or shepherd.hubSeat names one");
    await ports.send(seat, alertText(args, episode));
    return { seat, sent: true, detail: `told ${seat}` };
  } catch (error) {
    return unsent(seat ?? null, `${seat === undefined ? "the red seat could not be read" : `the alert to ${seat} failed`}: ${failureOf(error)}`);
  }
}

async function runThaw(args: ThawArgs, ctx: FactoryContext): Promise<ThawResult> {
  const services = servicesOf(ctx);
  const thawed = services.freeze.get().episodes.thawByHand(args.repo, args.redSha, args.actor, args.reason);
  if (thawed.outcome === "not-frozen") throw coded(`thaw refused, nothing changed: ${args.repo} has no open main-red episode`, EXIT.DATAERR);
  if (thawed.outcome === "red-moved") throw coded(`thaw refused, nothing changed: episode ${thawed.episode} on ${args.repo} is red at ${thawed.redSha}, not ${args.redSha}; read the new red before thawing it`, EXIT.DATAERR);
  const closedGates = closeThawedMainGates(ctx.host, services);
  const alert = await alertThaw(services, args, thawed.episode);
  return { repo: args.repo, episode: thawed.episode, redSha: args.redSha, actor: args.actor, fixTask: thawed.fixTask, closedGates, alert };
}

/** The manual way out of a main-red freeze; `shepherd unfreeze` lifts only a coordinator's freeze. */
export const thawCommand = defineCommand<ThawArgs, ThawResult, FactoryContext>({
  name: "shepherd.thaw",
  description: "Thaw owner/repo's main-red freeze by hand, only while its red sha is still --red-sha: records a thaw event with the caller and --reason, cancels the episode's stale main gates, leaves its fix task open, and alerts the repo's red seat",
  args: ThawArgs,
  result: z.custom<ThawResult>(),
  run: runThaw,
});
