import { join } from "node:path";
import { deployLockPath, releaseLock, takeLock, type LockPorts } from "./deploy-lock.js";

export const DEPLOY_PAUSE = "deploy-pause.json";

/** Why every deploy is held after a rollback of a restarted build. */
export interface DeployPause {
  pausedAt: string;
  target: string;
  /** The build sha `/health` reported before the deploy, or `unknown`. */
  from: string;
  why: string;
  /** `pending` is written before anything is restored, so a deployer killed mid-rollback still leaves the pause; `failed` means the old build was not seen serving. */
  rollback: "pending" | "verified" | "failed";
}

/** `pause` is undefined when the file exists but does not parse; that still pauses. */
export type PauseState = { paused: false } | { paused: true; pause: DeployPause | undefined };

export interface PauseReadPorts {
  exists: (path: string) => boolean;
  readFile: (path: string) => string | undefined;
}

export const deployPausePath = (stateDir: string): string => join(stateDir, DEPLOY_PAUSE);

function parsePause(text: string | undefined): DeployPause | undefined {
  try {
    const value = JSON.parse(text ?? "") as Partial<DeployPause> | null;
    return typeof value?.target === "string" && typeof value.pausedAt === "string" ? (value as DeployPause) : undefined;
  } catch {
    return undefined;
  }
}

/** Existence alone pauses, so a half-written or unreadable file cannot let a deploy through. */
export function readDeployPause(ports: PauseReadPorts, stateDir: string): PauseState {
  const path = deployPausePath(stateDir);
  return ports.exists(path) ? { paused: true, pause: parsePause(ports.readFile(path)) } : { paused: false };
}

export function writeDeployPause(ports: { writeFile: (path: string, text: string) => void }, stateDir: string, pause: DeployPause): void {
  ports.writeFile(deployPausePath(stateDir), `${JSON.stringify(pause, null, 2)}\n`);
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
