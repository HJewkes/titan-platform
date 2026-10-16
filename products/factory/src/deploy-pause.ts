import { join } from "node:path";
import { z } from "zod";
import { deployLockPath, releaseLock, takeLock, type LockPorts } from "./deploy-lock.js";

const DEPLOY_PAUSE = "deploy-pause.json";
const DEPLOY_HOLD = "deploy-hold.json";

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

/** A hold a person set by hand; kept apart from the failure pause so a rollback cannot overwrite its reason, nor it the rollback's. */
const ManualHoldSchema = z.object({
  heldAt: z.string(),
  reason: z.string().min(1),
});

type ManualHold = z.infer<typeof ManualHoldSchema>;

/** `pause` is undefined when the file exists but does not parse; that still pauses. */
type PauseState = { paused: false } | { paused: true; pause: DeployPause | undefined };

/** `hold` is undefined when the file exists but does not parse; that still holds. */
type ManualState = { set: false } | { set: true; hold: ManualHold | undefined };

interface HoldsState {
  held: boolean;
  failure: PauseState;
  manual: ManualState;
}

interface PauseReadPorts {
  exists: (path: string) => boolean;
  readFile: (path: string) => string | undefined;
}

export const deployPausePath = (stateDir: string): string => join(stateDir, DEPLOY_PAUSE);
export const deployHoldPath = (stateDir: string): string => join(stateDir, DEPLOY_HOLD);

function parseWith<T>(schema: z.ZodType<T>, text: string | undefined): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(text ?? ""));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Existence alone pauses, so a half-written or unreadable file cannot let a deploy through. */
export function readDeployPause(ports: PauseReadPorts, stateDir: string): PauseState {
  const path = deployPausePath(stateDir);
  return ports.exists(path) ? { paused: true, pause: parseWith(DeployPauseSchema, ports.readFile(path)) } : { paused: false };
}

/** Both holds; existence of either file alone holds every deploy. */
export function readDeployHolds(ports: PauseReadPorts, stateDir: string): HoldsState {
  const failure = readDeployPause(ports, stateDir);
  const path = deployHoldPath(stateDir);
  const manual: ManualState = ports.exists(path) ? { set: true, hold: parseWith(ManualHoldSchema, ports.readFile(path)) } : { set: false };
  return { held: failure.paused || manual.set, failure, manual };
}

/** Undefined once the hold is on disk, else why not. */
export function writeManualHold(ports: { writeFile: (path: string, text: string) => void }, stateDir: string, hold: ManualHold): string | undefined {
  try {
    ports.writeFile(deployHoldPath(stateDir), `${JSON.stringify(hold, null, 2)}\n`);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Read without taking the lock, since a manual hold must be settable while a deployer runs. */
export function runningDeployer(ports: Pick<LockPorts, "readFile" | "isAlive">, stateDir: string): number | undefined {
  const pid = Number(ports.readFile(deployLockPath(stateDir))?.trim());
  return Number.isInteger(pid) && pid > 0 && ports.isAlive(pid) ? pid : undefined;
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

function describePause(state: PauseState): string {
  if (!state.paused) return "deploys are not paused";
  const { pause } = state;
  if (pause === undefined) return `deploys are paused: ${DEPLOY_PAUSE} exists but does not parse`;
  return `deploys are paused since ${pause.pausedAt}: ${pause.target} over ${pause.from} rolled back (rollback ${pause.rollback}): ${pause.why}`;
}

export function describeManualHold(state: ManualState): string {
  if (!state.set) return "deploys are not held by hand";
  const { hold } = state;
  if (hold === undefined) return `deploys are held by hand: ${DEPLOY_HOLD} exists but does not parse`;
  return `deploys are held by hand since ${hold.heldAt}: ${hold.reason}`;
}

/** One line per standing hold, so a manual hold never hides a failure pause or the reverse. */
export function describeHolds(state: HoldsState): string[] {
  if (!state.held) return ["deploys are not paused"];
  return [...(state.failure.paused ? [describePause(state.failure)] : []), ...(state.manual.set ? [describeManualHold(state.manual)] : [])];
}

/** Under the deploy lock, so a clear cannot land between a deployer's pause write and its rollback's end. */
export function clearDeployPause(ports: LockPorts & PauseReadPorts, stateDir: string): string | undefined {
  const lock = deployLockPath(stateDir);
  const held = takeLock(ports, lock);
  if (held !== undefined) return held;
  try {
    const holds = readDeployHolds(ports, stateDir);
    if (holds.failure.paused) ports.remove(deployPausePath(stateDir));
    if (holds.manual.set) ports.remove(deployHoldPath(stateDir));
    return undefined;
  } finally {
    releaseLock(ports, lock);
  }
}
