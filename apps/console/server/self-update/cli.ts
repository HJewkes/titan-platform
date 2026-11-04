import { homedir } from "node:os";
import path from "node:path";
import type { ConsoleConfig } from "../config.js";
import { legacySelfUpdate, spawnNode, type SpawnNode } from "./legacy.js";
import { nodeUpdatePorts, smokeRelease } from "./node-ports.js";
import { SMOKE_FLAG, verdictLine } from "./release-smoke.js";
import { applyRelease, EXIT, reportRecorded, type UpdateOptions } from "./update.js";

const APPLY_FLAG = "--apply";
const REPORT_FLAG = "--report";

export const SELF_UPDATE_USAGE = `       titan-console self-update --apply <sha>
                                        swap in releases/<sha>, which the bootstrap built, when a console
                                        change landed; rolls back when /health does not answer as <sha>`;

const expandHome = (value: string, home: string): string => (value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value);

/** `TITAN_CONSOLE_UPDATE_ROOT`, `TITAN_CONSOLE_UNIT` and `TITAN_CONSOLE_BIN_DIR` exist for a second install; the defaults are the served console's. */
function updateOptions(config: ConsoleConfig, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): UpdateOptions {
  return {
    root: expandHome(env.TITAN_CONSOLE_UPDATE_ROOT || "~/.local/share/titan-console", home),
    stateDir: config.stateDir,
    port: config.port,
    unit: env.TITAN_CONSOLE_UNIT || "titan-console.service",
    binDir: expandHome(env.TITAN_CONSOLE_BIN_DIR || "~/.local/bin", home),
  };
}

type SelfUpdateArgs = { kind: "legacy" } | { kind: "apply"; sha: string } | { kind: "report" } | { kind: "smoke"; release: string; sha: string };

/**
 * `--apply <sha>` and `--report` are what the bootstrap runs, in the new release and the serving one. `--smoke` is the
 * verb an updater from before the bootstrap runs inside the release it built, so it stays. The bare verb is what a
 * timer unit from before the bootstrap runs; it runs the serving release's copy of the bootstrap.
 */
export function selfUpdateArgs(argv: readonly string[]): SelfUpdateArgs | null {
  if (argv[0] !== "self-update") return null;
  const [, flag, first, second] = argv;
  if (argv.length === 1) return { kind: "legacy" };
  if (argv.length === 2 && flag === REPORT_FLAG) return { kind: "report" };
  if (argv.length === 3 && flag === APPLY_FLAG && first !== undefined && /^[0-9a-f]{40}$/.test(first)) return { kind: "apply", sha: first };
  return argv.length === 4 && flag === SMOKE_FLAG && first !== undefined && second !== undefined ? { kind: "smoke", release: first, sha: second } : null;
}

/** Prints one verdict line for the updater; SIGTERM from its timeout still stops the smoke daemon. */
async function smokeCli(release: string, sha: string): Promise<number> {
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  const why = await smokeRelease(release, sha, { signal: stop.signal });
  console.log(verdictLine(why));
  return why === undefined ? EXIT.OK : EXIT.FAILED;
}

export function selfUpdateVerb(config: () => ConsoleConfig, args: SelfUpdateArgs, spawn: SpawnNode = spawnNode): Promise<number> {
  if (args.kind === "smoke") return smokeCli(args.release, args.sha);
  const resolved = config();
  if (args.kind === "legacy") return legacySelfUpdate(spawn, updateOptions(resolved));
  const ports = nodeUpdatePorts(resolved.inboxDir);
  return args.kind === "report" ? reportRecorded(ports, resolved.stateDir) : applyRelease(ports, updateOptions(resolved), args.sha);
}
