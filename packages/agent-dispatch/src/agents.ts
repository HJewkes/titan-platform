/**
 * Read agent-chat's roster and retire an agent, through the same CLI boundary
 * and `execSafe` discipline as dispatch.ts: absolute binary, argv array,
 * minimal env, no shell.
 *
 * The roster comes from `agent-chat agent ls --json`, a fold over the broker's
 * durable log, so it answers "has this agent ended" correctly whenever it is
 * asked. A row missing a field this module relies on is skipped rather than
 * guessed at: an invented status could strand a finished agent or resume one
 * that is still writing its transcript.
 */

import {
  DispatchError,
  DispatchTimeoutError,
  PEER_NAME_PATTERN,
  agentChatEnv,
  brokerUnavailable,
  isBrokerUnavailable,
} from "./dispatch.js";
import {
  ExecError,
  ExecTimeoutError,
  execSafe,
  execSafeAsync,
  resolveBinaryPath,
  type SafeExecResult,
} from "./exec.js";

/**
 * One `agent ls --json` row, as agent-chat's `lsJsonRow` writes it. The
 * optional fields are dropped when a row carries them with the wrong type,
 * so a consumer never sees a value the type does not describe.
 */
export interface AgentRow {
  name: string;
  agentId: string;
  /** Lifecycle from the log, such as `live` or `exited`. */
  state: string;
  /** `live`, `detached` or `exited`: whether a session holds the name now. */
  presence: string;
  /** agent-chat's rendered status, such as `running`, `finished` or `retired`. */
  status: string;
  profile: string;
  surface: string;
  model?: string | null;
  cwd: string;
  /** Empty until the agent's Claude Code session has started. */
  sessionId: string;
  transcriptPath?: string | null;
  transcriptExists?: boolean;
  spawnedBy?: string | null;
  account?: string | null;
  generation: number;
  teleportFrom?: string | null;
}

export interface RetireResult {
  name: string;
  /** What the broker could not do on a successful retire, verbatim. */
  caveats: string[];
}

export function buildListAgentsArgs(): string[] {
  return ["agent", "ls", "--json"];
}

export function buildRetireArgs(name: string, force = false): string[] {
  return ["agent", "retire", name, ...(force ? ["--force"] : [])];
}

/** Every agent the broker's log knows, live or ended. */
export async function listAgents(
  agentChatBinPath: string,
  timeoutMs: number,
): Promise<AgentRow[]> {
  const result = await runAgentChatAsync(
    agentChatBinPath,
    buildListAgentsArgs(),
    timeoutMs,
  );
  if (result.status !== 0) throw refusal("agent ls", result);
  return parseAgentRows(result.stdout);
}

/**
 * Release the agent's isolation, end its process and free its name. `force`
 * discards uncommitted or unmerged work its worktree holds.
 */
export function retire(
  agentChatBinPath: string,
  name: string,
  timeoutMs: number,
  options: { force?: boolean } = {},
): RetireResult {
  if (!PEER_NAME_PATTERN.test(name)) {
    throw new DispatchError(`invalid peer name: '${name}'`);
  }
  const args = buildRetireArgs(name, options.force === true);
  const result = runAgentChat(agentChatBinPath, args, timeoutMs);
  if (result.status !== 0) throw refusal("agent retire", result);
  const lines = result.stdout.split("\n").map((line) => line.trim());
  return { name, caveats: lines.slice(1).filter((line) => line !== "") };
}

/** Throws `DispatchError` on a malformed payload; skips a malformed row. */
export function parseAgentRows(stdout: string): AgentRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new DispatchError("agent-chat agent ls --json printed invalid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new DispatchError("agent-chat agent ls --json did not print an array");
  }
  return parsed.flatMap((value: unknown) => {
    const row = toAgentRow(value);
    return row === undefined ? [] : [row];
  });
}

type FieldCheck = (value: unknown) => boolean;

const isString: FieldCheck = (value) => typeof value === "string";
const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

type RequiredKey = { [K in keyof AgentRow]-?: undefined extends AgentRow[K] ? never : K }[keyof AgentRow];
type OptionalKey = Exclude<keyof AgentRow, RequiredKey>;
type RawRow = Record<string, unknown> & Pick<AgentRow, RequiredKey>;

/** A row failing any of these is skipped: an invented status could strand or resume the wrong agent. */
const REQUIRED_FIELDS: Record<RequiredKey, FieldCheck> = {
  name: isString,
  agentId: isString,
  state: isString,
  presence: isString,
  status: isString,
  profile: isString,
  surface: isString,
  cwd: isString,
  sessionId: isString,
  generation: (value) => Number.isSafeInteger(value),
};

function hasRequiredFields(value: unknown): value is RawRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return Object.entries(REQUIRED_FIELDS).every(([key, check]) => check(row[key]));
}

/** An optional field with the wrong type is dropped rather than costing the whole row. */
function optionalField<K extends OptionalKey>(
  row: RawRow,
  key: K,
  check: (value: unknown) => value is Exclude<AgentRow[K], undefined>,
): Partial<Pick<AgentRow, K>> {
  const picked: Partial<Pick<AgentRow, K>> = {};
  const value = row[key];
  if (check(value)) picked[key] = value;
  return picked;
}

function toAgentRow(value: unknown): AgentRow | undefined {
  if (!hasRequiredFields(value)) return undefined;
  const { name, agentId, state, presence, status, profile, surface, cwd, sessionId, generation } = value;
  return {
    ...{ name, agentId, state, presence, status, profile, surface, cwd, sessionId, generation },
    ...optionalField(value, "model", isStringOrNull),
    ...optionalField(value, "transcriptPath", isStringOrNull),
    ...optionalField(value, "transcriptExists", isBoolean),
    ...optionalField(value, "spawnedBy", isStringOrNull),
    ...optionalField(value, "account", isStringOrNull),
    ...optionalField(value, "teleportFrom", isStringOrNull),
  };
}

export function runAgentChat(
  binPath: string,
  args: string[],
  timeoutMs: number,
): SafeExecResult {
  try {
    const bin = resolveBinaryPath(binPath, "agent-chat");
    return execSafe(bin, args, agentChatEnv(), timeoutMs);
  } catch (err) {
    throw mapExecError(err);
  }
}

/** The roster is large (hundreds of rows), so its read must not block the caller's event loop. */
export async function runAgentChatAsync(
  binPath: string,
  args: string[],
  timeoutMs: number,
  input?: string,
): Promise<SafeExecResult> {
  try {
    const bin = resolveBinaryPath(binPath, "agent-chat");
    return await execSafeAsync(bin, args, agentChatEnv(), timeoutMs, input);
  } catch (err) {
    throw mapExecError(err);
  }
}

function mapExecError(err: unknown): unknown {
  if (err instanceof ExecTimeoutError) return new DispatchTimeoutError(err.message);
  if (err instanceof ExecError) return new DispatchError(err.message);
  return err;
}

/** Same stream rule as a spawn: a broker refusal is on stdout, a usage error on stderr. */
export function refusal(verb: string, result: SafeExecResult): DispatchError {
  if (isBrokerUnavailable(result)) return brokerUnavailable(verb, result);
  const reason = result.stdout.trim() || result.stderr.trim();
  return new DispatchError(
    reason === ""
      ? `agent-chat ${verb} exited ${result.status}`
      : `agent-chat refused ${verb}: ${reason}`,
  );
}
