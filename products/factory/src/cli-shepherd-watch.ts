import { InvalidArgumentError, type Command } from "commander";
import type { Verbs } from "./cli.js";
import { callerOf } from "./cli-options.js";
import { parsePrRef } from "./registry.js";
import type { ShepherdCommandName } from "./shepherd/commands.js";
import { WATCH_EVENTS, WatchEventSchema, type WatchEvent } from "./shepherd/watch-list.js";

interface WatchVerbOpts {
  port: number;
  json?: boolean;
  on?: WatchEvent[];
  seat?: string;
  list?: boolean;
}

/** `cli-shepherd.ts`'s own verb builder and runner, passed in so this file does not import it back. */
type VerbOf = (spec: string, description: string) => Command;
type RunShepherd = (verbs: Verbs, name: ShepherdCommandName, argsOf: () => object, opts: WatchVerbOpts) => Promise<void>;

/** `shepherd watch` replaces the Monitor loops and `shepherd wait` runs seats arm on a registered PR: the seat digest brings the news. */
export function registerShepherdWatch(verb: VerbOf, verbs: Verbs, run: RunShepherd): void {
  verb("watch [ref]", "watch owner/repo#N: its --on events reach the seat in the next settled digest instead of the batch flush, and the watch drops once a sent digest tells the run's end; exit 1 when the PR is not registered or --seat is not in the seat book")
    .option("--on <events>", `comma-separated events: ${WATCH_EVENTS.join(", ")} (default: all)`, parseEvents)
    .option("--seat <name>", "a seat in the seat book that gets a copy of the run's digest lines and the prompt wake, while the run's own seat keeps them (default: the run's own digest seat)")
    .option("--list", "list every watch instead")
    .action((ref: string | undefined, opts: WatchVerbOpts) => run(verbs, "shepherd.watch", () => watchArgs(ref, opts, verbs.io.env), opts));
  verb("unwatch <ref>", "drop the watch on owner/repo#N; its events go back to the digest's usual pacing")
    .action((ref: string, opts: WatchVerbOpts) => run(verbs, "shepherd.watch", () => ({ action: "unwatch", ...parsePrRef(ref) }), opts));
}

function watchArgs(ref: string | undefined, opts: WatchVerbOpts, env: NodeJS.ProcessEnv): object {
  if (opts.list) {
    if (ref !== undefined || opts.on !== undefined || opts.seat !== undefined) throw new Error("--list takes no ref, --on or --seat");
    return { action: "list" };
  }
  if (ref === undefined) throw new Error("watch needs owner/repo#N, or --list");
  return { action: "watch", ...parsePrRef(ref), ...(opts.on && { on: opts.on }), ...(opts.seat !== undefined && { seat: opts.seat }), actor: callerOf(env) };
}

function parseEvents(value: string): WatchEvent[] {
  const names = value.split(",").map((event) => event.trim());
  const unknown = names.filter((event) => !WatchEventSchema.safeParse(event).success);
  if (unknown.length > 0) throw new InvalidArgumentError(`unknown event ${unknown.join(", ")}; expected ${WATCH_EVENTS.join(", ")}`);
  return names.map((event) => WatchEventSchema.parse(event));
}
