import { setTimeout as sleep } from "node:timers/promises";
import type { JsonEnvelope } from "@titan-design/registry";
import { InvalidArgumentError, type Command } from "commander";
import { parsePort, parsePositiveInt } from "./cli-options.js";
import { statusRows, type Verbs } from "./cli.js";
import { EXIT } from "./exit-codes.js";
import { parsePrRef } from "./registry.js";
import { FACTORY_PORT } from "./serve.js";
import { FINISHED_PHASES, PhaseSchema, type Phase } from "./shepherd/step-phase.js";
import { z } from "zod";

export interface WaitOptions {
  ref: string;
  until: ReadonlySet<Phase>;
  timeoutMs: number;
  intervalMs: number;
}

/** What one wait reads the run's status through and keeps time with; tests swap in their own. */
export interface WaitPorts {
  readRows: () => Promise<JsonEnvelope<unknown>>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stderr: (text: string) => void;
}

/** Only the phase of each status row matters here, so a newer serve's extra row fields never fail a wait. */
const PhaseRows = z.array(z.object({ phase: PhaseSchema }));

interface WaitArgs {
  until: Phase[];
  timeout: number;
  interval: number;
  port: number;
}

/** `shepherd wait` replaces the hand-written `while … sleep … shepherd status` loops seats wrote around a PR. */
export function registerShepherdWait(shepherd: Command, verbs: Verbs): void {
  shepherd
    .command("wait <ref>")
    .description("poll owner/repo#N until its run reaches one of the --until phases; exit 1 if it ends in another or the timeout passes")
    .requiredOption("--until <phases>", `comma-separated phases: ${PhaseSchema.options.join(", ")}`, parsePhases)
    .option("--timeout <s>", "seconds to wait before giving up", parsePositiveInt, 900)
    .option("--interval <s>", "seconds between polls", parsePositiveInt, 15)
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action(async (ref: string, opts: WaitArgs) => {
      let target: { repo: string; pr: number };
      try {
        target = parsePrRef(ref);
      } catch (err) {
        verbs.io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        return verbs.setExit(EXIT.USAGE);
      }
      const options = { ref, until: new Set(opts.until), timeoutMs: opts.timeout * 1_000, intervalMs: opts.interval * 1_000 };
      const ports = { readRows: () => statusRows(verbs, target, opts.port), now: Date.now, sleep: (ms: number) => sleep(ms), stderr: verbs.io.stderr };
      verbs.setExit(await waitForPhase(options, ports));
    });
}

function parsePhases(value: string): Phase[] {
  const names = value.split(",").map((phase) => phase.trim());
  const unknown = names.filter((phase) => !PhaseSchema.safeParse(phase).success);
  if (unknown.length > 0) throw new InvalidArgumentError(`unknown phase ${unknown.join(", ")}; expected ${PhaseSchema.options.join(", ")}`);
  return names.map((phase) => PhaseSchema.parse(phase));
}

/** Polls until the PR's newest row is in an `until` phase (0), or its run ends elsewhere or time runs out (1). */
export async function waitForPhase(options: WaitOptions, ports: WaitPorts): Promise<number> {
  const deadline = ports.now() + options.timeoutMs;
  for (;;) {
    const envelope = await ports.readRows();
    if (!envelope.ok) return fail(ports, envelope.error);
    const phase = PhaseRows.parse(envelope.data).at(-1)?.phase;
    if (!phase) return fail(ports, `${options.ref} is not registered with shepherd`);
    if (options.until.has(phase)) return EXIT.OK;
    if (FINISHED_PHASES.has(phase)) return fail(ports, `${options.ref} ended in ${phase}, not ${[...options.until].join(" or ")}`);
    const left = deadline - ports.now();
    if (left <= 0) return fail(ports, `timed out after ${options.timeoutMs / 1_000} s; ${options.ref} is still in ${phase}`);
    await ports.sleep(Math.min(options.intervalMs, left));
  }
}

function fail(ports: WaitPorts, reason: string): number {
  ports.stderr(`error: ${reason}\n`);
  return EXIT.FAILURE;
}
