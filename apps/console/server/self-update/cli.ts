import { homedir } from "node:os";
import path from "node:path";
import type { ConsoleConfig } from "../config.js";
import { nodeUpdatePorts, smokeRelease } from "./node-ports.js";
import { SMOKE_FLAG, verdictLine } from "./release-smoke.js";
import { EXIT, selfUpdate, type UpdateOptions } from "./update.js";

export const SELF_UPDATE_USAGE = `       titan-console self-update        build origin/main into a new release and swap it in when a console
                                        change landed; the old build keeps serving on any failure`;

const expandHome = (value: string, home: string): string => (value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value);

/** `TITAN_CONSOLE_UPDATE_ROOT` and `TITAN_CONSOLE_UNIT` exist for a second install; the defaults are the served console's. */
function updateOptions(config: ConsoleConfig, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): UpdateOptions {
  return {
    root: expandHome(env.TITAN_CONSOLE_UPDATE_ROOT || "~/.local/share/titan-console", home),
    stateDir: config.stateDir,
    port: config.port,
    unit: env.TITAN_CONSOLE_UNIT || "titan-console.service",
  };
}

function selfUpdateCli(config: ConsoleConfig): Promise<number> {
  return selfUpdate(nodeUpdatePorts(config.inboxDir), updateOptions(config));
}

type SelfUpdateArgs = { kind: "update" } | { kind: "smoke"; release: string; sha: string };

/** `self-update --smoke <release> <sha>` is the verb the updater runs inside the release it just built. */
export function selfUpdateArgs(argv: readonly string[]): SelfUpdateArgs | null {
  if (argv[0] !== "self-update") return null;
  if (argv.length === 1) return { kind: "update" };
  const [, flag, release, sha] = argv;
  return argv.length === 4 && flag === SMOKE_FLAG && release !== undefined && sha !== undefined ? { kind: "smoke", release, sha } : null;
}

/** Prints one verdict line for the updater; SIGTERM from its timeout still stops the smoke daemon. */
async function smokeCli(release: string, sha: string): Promise<number> {
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  const why = await smokeRelease(release, sha, { signal: stop.signal });
  console.log(verdictLine(why));
  return why === undefined ? EXIT.OK : EXIT.FAILED;
}

export function selfUpdateVerb(config: () => ConsoleConfig, args: SelfUpdateArgs): Promise<number> {
  return args.kind === "smoke" ? smokeCli(args.release, args.sha) : selfUpdateCli(config());
}
