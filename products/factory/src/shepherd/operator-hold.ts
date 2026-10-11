import { execFileSync } from "node:child_process";
import { z } from "zod";

/**
 * CC-1037: an operator HOLD in agent-chat (the stop file, or a machine-scoped HOLD from a `machineHoldOperators` sender), read
 * from `agent-chat machine status --json`, so Shepherd goes quiet under a hold even when the machine shows no pressure.
 * `unreadable` is its own state: the spawn gate fails closed on it, and the machine-stop watch keeps its previous answer.
 */
export type OperatorHoldRead = { state: "clear" } | { state: "held"; reason: string } | { state: "unreadable"; reason: string };

const Hold = z.looseObject({ by: z.string(), since: z.string(), reason: z.string() });
/** Only `holds` and `errors`: `machine.stop` is the readings Shepherd already reads itself, and owner stops hold one seat each. */
const Status = z.looseObject({ holds: z.array(Hold), errors: z.array(z.string()) });

type Exec = (bin: string, args: readonly string[]) => string;

interface OperatorHoldReaderOptions {
  exec?: Exec;
  now?: () => number;
  /** How long one answer is reused, so a burst of spawn asks costs one exec. */
  ttlMs?: number;
  log?: (line: string) => void;
}

export const OPERATOR_HOLD_TTL_MS = 15_000;
const EXEC_TIMEOUT_MS = 5000;

const execStatus: Exec = (bin, args) => execFileSync(bin, args, { encoding: "utf8", timeout: EXEC_TIMEOUT_MS });

/** Pure: the answer one status document gives; a source agent-chat could not read makes the whole answer unreadable. */
export function holdFromStatus(json: string): OperatorHoldRead {
  const status = Status.parse(JSON.parse(json));
  if (status.errors.length > 0) return { state: "unreadable", reason: `agent-chat could not read ${status.errors.join(", ")}` };
  const hold = status.holds[0];
  if (hold === undefined) return { state: "clear" };
  return { state: "held", reason: `operator HOLD by ${hold.by} since ${hold.since}: ${hold.reason}` };
}

function readStatus(agentChatBin: string, exec: Exec): OperatorHoldRead {
  try {
    return holdFromStatus(exec(agentChatBin, ["machine", "status", "--json"]));
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { state: "unreadable", reason: `agent-chat machine status failed: ${detail}` };
  }
}

/** Reads the operator hold through `<agentChatBin> machine status --json`, caching each answer for `ttlMs`; logs once per unreadable streak. */
export function operatorHoldReader(agentChatBin: string, options: OperatorHoldReaderOptions = {}): () => OperatorHoldRead {
  const { exec = execStatus, now = Date.now, ttlMs = OPERATOR_HOLD_TTL_MS, log = (line) => console.warn(line) } = options;
  let cached: { at: number; read: OperatorHoldRead } | undefined;
  return () => {
    const at = now();
    if (cached !== undefined && at - cached.at < ttlMs) return cached.read;
    const read = readStatus(agentChatBin, exec);
    if (read.state === "unreadable" && cached?.read.state !== "unreadable") log(`shepherd: operator_hold unreadable: ${read.reason}`);
    cached = { at, read };
    return read;
  };
}
