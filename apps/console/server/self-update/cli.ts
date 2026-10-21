import { homedir } from "node:os";
import path from "node:path";
import type { ConsoleConfig } from "../config.js";
import { nodeUpdatePorts } from "./node-ports.js";
import { selfUpdate, type UpdateOptions } from "./update.js";

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

export function selfUpdateCli(config: ConsoleConfig): Promise<number> {
  return selfUpdate(nodeUpdatePorts(config.inboxDir), updateOptions(config));
}
