import { join } from "node:path";
import { z } from "zod";
import { deployLockPath, releaseLock, takeLock, type LockPorts } from "./deploy-lock.js";

const DEPLOY_PAUSE = "deploy-pause.json";

/** Why every deploy is held after a rollback of a restarted build. */
const DeployPauseSchema = z.object({
  pausedAt: z.string(),
  target: z.string(),
  /** The build sha `/health` reported before the deploy, or `unknown`. */
  from: z.string(),
  why: z.string(),
  /** `pending` is written before anything is restored, so a deployer killed mid-rollback still leaves the pause; `failed` means the old build was not seen serving. */
  rollback: z.enum(["pending", "verified", "failed"]),
});

export type DeployPause = z.infer<typeof DeployPauseSchema>;

/** `pause` is undefined when the file exists but does not parse; that still pauses. */
type PauseState = { paused: false } | { paused: true; pause: DeployPause | undefined };

interface PauseReadPorts {
  exists: (path: string) => boolean;
  readFile: (path: string) => string | undefined;
}

export const deployPausePath = (stateDir: string): string => join(stateDir, DEPLOY_PAUSE);

function parsePause(text: string | undefined): DeployPause | undefined {
  try {
    const parsed = DeployPauseSchema.safeParse(JSON.parse(text ?? ""));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Existence alone pauses, so a half-written or unreadable file cannot let a deploy through. */
export function readDeployPause(ports: PauseReadPorts, stateDir: string): PauseState {
  const path = deployPausePath(stateDir);
  return ports.exists(path) ? { paused: true, pause: parsePause(ports.readFile(path)) } : { paused: false };
}

/** Undefined once the pause is on disk, else why not; a lost write must not stop the rollback that follows it. */
export function writeDeployPause(ports: { writeFile: (path: string, text: string) => void }, stateDir: string, pause: DeployPause): string | undefined {
  try {
    ports.writeFile(deployPausePath(stateDir), `${JSON.stringify(pause, null, 2)}\n`);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function describePause(state: PauseState): string {
  if (!state.paused) return "deploys are not paused";
  const { pause } = state;
  if (pause === undefined) return `deploys are paused: ${DEPLOY_PAUSE} exists but does not parse`;
  return `deploys are paused since ${pause.pausedAt}: ${pause.target} over ${pause.from} rolled back (rollback ${pause.rollback}): ${pause.why}`;
}

/** Under the deploy lock, so a clear cannot land between a deployer's pause write and its rollback's end. */
export function clearDeployPause(ports: LockPorts & PauseReadPorts, stateDir: string): string | undefined {
  const lock = deployLockPath(stateDir);
  const held = takeLock(ports, lock);
  if (held !== undefined) return held;
  try {
    if (readDeployPause(ports, stateDir).paused) ports.remove(deployPausePath(stateDir));
    return undefined;
  } finally {
    releaseLock(ports, lock);
  }
}
