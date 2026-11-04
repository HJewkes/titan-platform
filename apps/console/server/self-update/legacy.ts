import { spawn } from "node:child_process";
import path from "node:path";

/** Runs `node <script>` with the output inherited and the given env, and resolves its exit code. */
export type SpawnNode = (script: string, env: NodeJS.ProcessEnv) => Promise<number>;

interface LegacyOptions {
  root: string;
  stateDir: string;
}

const FAILED = 1;
const BOOTSTRAP_IN_RELEASE = "apps/console/deploy/titan-console-bootstrap.mts";

/**
 * The bare `self-update` a timer unit from before the bootstrap still runs. It runs the serving release's own copy of
 * the bootstrap, so the old unit keeps updating with no owner step; installing the bootstrap outside the release is
 * optional hardening.
 */
export function legacySelfUpdate(spawnNode: SpawnNode, options: LegacyOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const script = path.join(options.root, "current", BOOTSTRAP_IN_RELEASE);
  return spawnNode(script, { ...env, TITAN_CONSOLE_UPDATE_ROOT: options.root, TITAN_CONSOLE_STATE: options.stateDir });
}

export function spawnNode(script: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env, stdio: "inherit" });
    child.once("error", () => resolve(FAILED));
    child.once("close", (code) => resolve(code ?? FAILED));
  });
}
