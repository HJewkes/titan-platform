import type { OwnerOp } from "@titan-design/owner-queue";
import { refused, type Outcome } from "../console-action/outcome.js";
import type { OpRead } from "../console-action/record.js";
import { deployLockPath, releaseLock, takeLock, type LockPorts } from "../deploy-lock.js";
import { deployHeldHealth, deployPausePath, readDeployPause, runningDeployer, type DeployPause } from "../deploy-pause.js";
import type { LedgerLine, OwnerOpsLedger } from "./ledger.js";

type PauseClear = Extract<OwnerOp, { kind: "deploy-pause-clear" }>;

/** The deploy lock's ports and the one existence read the pause files add. */
export type PauseClearPorts = LockPorts & { exists: (path: string) => boolean };

interface DeployState {
  stateDir: string;
  ports: PauseClearPorts;
}

export interface PauseClearDeps {
  deploy: DeployState;
  ledger: OwnerOpsLedger;
}

/**
 * Removes the failure pause a rolled-back deploy left, and only while it still names the record's `pausedAt` and `target`, so
 * a newer rollback is never cleared blind. The manual hold is a person's own and is never touched. The check and the removal
 * run under the deploy lock, so a deployer cannot write a new pause between them.
 */
export async function clearPause(actionId: string, { op }: OpRead, deps: PauseClearDeps): Promise<Outcome> {
  if (op.kind !== "deploy-pause-clear") return refused("record", `deploy-pause-clear cannot run a ${op.kind} op`);
  const { stateDir, ports } = deps.deploy;
  const running = runningDeployer(ports, stateDir);
  if (running !== undefined) return refused("deploying", `a deployer is running (pid ${running}); tap again once it ends`);
  const clearedBefore = (await deps.ledger.read(actionId)).some(clearedByThis);
  const lock = deployLockPath(stateDir);
  const busy = takeLock(ports, lock);
  if (busy !== undefined) return refused("deploying", busy);
  try {
    return clearUnderLock(op, deps.deploy, clearedBefore);
  } finally {
    releaseLock(ports, lock);
  }
}

const NO_PAUSE = "no failure pause stands; deploys were not paused by a rollback, or it was cleared elsewhere";

const clearedByThis =(entry: LedgerLine): boolean => entry.phase === "done" && entry.result !== undefined && "clearedPause" in entry.result;

function clearUnderLock(op: PauseClear, { stateDir, ports }: DeployState, clearedBefore: boolean): Outcome {
  const state = readDeployPause(ports, stateDir);
  if (!state.paused) return clearedBefore ? { outcome: "already", clearedPause: op.pausedAt } : { outcome: "gone", reason: NO_PAUSE };
  if (state.pause === undefined) return refused("mismatch", "the deploy pause file does not parse, so it cannot be matched to this pause; clear it on the terminal");
  if (!samePause(state.pause, op)) return { outcome: "moved", currentPause: state.pause.pausedAt };
  ports.remove(deployPausePath(stateDir));
  return { outcome: "pause-cleared", clearedPause: op.pausedAt, stillHeld: manualHoldReason(ports, stateDir) };
}

const samePause = (pause: DeployPause, op: PauseClear): boolean => pause.pausedAt === op.pausedAt && pause.target === op.target;

/** The manual hold's reason when one stands, so the owner learns deploys stay held after the pause is gone. */
export function manualHoldReason(ports: Pick<PauseClearPorts, "exists" | "readFile">, stateDir: string): string | null {
  const held = deployHeldHealth(ports, stateDir);
  return held.held === false ? null : (held.reason ?? "a manual hold");
}
