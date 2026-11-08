import type { Command } from "commander";
import type { Verbs } from "../cli-types.js";
import { EXIT } from "../exit-codes.js";
import { runProcess } from "./inputs.js";
import { machineWindowSources } from "./window-ports.js";
import { probeWindow, WINDOW_PROBES, type WindowProbe, type WindowSources } from "./window-probes.js";

interface ProbeOpts {
  since: string;
  repo: string[];
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** Exits non-zero on any read it cannot finish, so the wake runs the review instead of skipping on a blind probe. */
export async function runWindowProbe(probe: string, opts: ProbeOpts, sources: () => WindowSources, verbs: Verbs): Promise<number> {
  const { io } = verbs;
  if (!(WINDOW_PROBES as readonly string[]).includes(probe) || !ISO_TIME.test(opts.since)) {
    io.stderr(`planner probe: want one of ${WINDOW_PROBES.join(", ")} and an ISO --since, got ${probe} ${opts.since}\n`);
    return EXIT.USAGE;
  }
  try {
    const read = sources();
    if (probe !== "owner-contact" && read.repos.length === 0) throw new Error("no repos: pass --repo or configure seats");
    const lines = await probeWindow(probe as WindowProbe, read, opts.since);
    io.stdout(lines.map((line) => `${line}\n`).join(""));
    return EXIT.OK;
  } catch (error) {
    io.stderr(`planner probe ${probe}: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.FAILURE;
  }
}

/** `titan-factory planner probe <kind> --since <iso>`: the priorWindow commands a planner wake config points at. */
export function registerPlannerProbe(planner: Command, verbs: Verbs): void {
  planner
    .command("probe")
    .description("print one line per merge, owner contact or new red event since --since; exits non-zero when a source cannot be read")
    .argument("<kind>", WINDOW_PROBES.join(" | "))
    .requiredOption("--since <iso>", "window start, as the wake fills {since}")
    .option("--repo <owner/repo>", "a repo to read; repeat for more (default: every seat repo)", collect, [])
    .action(async (kind: string, opts: ProbeOpts) => {
      const run = verbs.deps.planner?.run ?? runProcess;
      const sources = verbs.deps.planner?.windowSources ?? (() => machineWindowSources(verbs, run, opts.repo));
      verbs.setExit(await runWindowProbe(kind, opts, sources, verbs));
    });
}
