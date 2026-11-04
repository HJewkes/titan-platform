import type { StatusReport } from "./events.js";
import type { AccountUsage, Presence, RosterEntry, Slots, StatusLineReading, UsageWindow } from "./inputs.js";

/**
 * One frame of the panel, as the feed prints it. Every reading keeps the time it was taken
 * (or its age at `atMs`), never a bare figure: the view ages them against its own clock, so
 * a feed that went quiet cannot make an old reading look current.
 */
export interface Snapshot {
  atMs: number;
  agents: AgentRow[];
  accounts: AccountStrip[];
  slots: Slots | null;
  /** Why a source could not be read on the last reconcile; empty when all were. */
  errors: string[];
}

export interface AgentRow {
  name: string;
  presence: Presence;
  profile: string;
  model: string | null;
  account: string | null;
  task: string | null;
  report: StatusReport | null;
  context: ContextReading | null;
  cost: CostReading | null;
}

/** `pct` from the status line, else only `k` tokens from the transcript (which knows no window size). */
export type ContextReading =
  | { source: "status-line"; pct: number; atMs: number }
  | { source: "transcript"; k: number };

export interface CostReading {
  usd: number;
  atMs: number;
}

export interface AccountStrip {
  account: string;
  agents: number;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** When the reading was taken; null when the account has none. */
  readAtMs: number | null;
  stale: boolean;
  authFail: boolean;
}

export interface SnapshotInputs {
  nowMs: number;
  roster: readonly RosterEntry[];
  accounts: readonly AccountUsage[];
  /** Status-line readings by session id. */
  statusLines: ReadonlyMap<string, StatusLineReading>;
  reportOf: (name: string) => StatusReport | null;
  taskOf: (name: string) => string | null;
  slots: Slots | null;
  errors: string[];
}

/** An exited agent stays on the roster this long, so a finish is seen before it drops off. */
export const EXITED_SHOWN_MS = 30 * 60_000;

const DEFAULT_ACCOUNT = "default";
const PRESENCE_ORDER: Record<Presence, number> = { live: 0, detached: 1, exited: 2 };

/** A config dir's short name: its last segment without the leading dot, so `~/.claude` is `claude`. */
export function accountChip(configDir: string | null): string {
  if (configDir === null) return DEFAULT_ACCOUNT;
  const last = configDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  return last.replace(/^\.+/, "") || DEFAULT_ACCOUNT;
}

function contextOf(entry: RosterEntry, line: StatusLineReading | undefined): ContextReading | null {
  if (line?.contextPct != null) return { source: "status-line", pct: line.contextPct, atMs: line.writtenAtMs };
  return entry.contextK === null ? null : { source: "transcript", k: entry.contextK };
}

function agentRow(entry: RosterEntry, inputs: SnapshotInputs): AgentRow {
  const line = inputs.statusLines.get(entry.sessionId);
  return {
    name: entry.name,
    presence: entry.presence,
    profile: entry.profile,
    model: entry.model,
    account: entry.configDir === null ? null : accountChip(entry.configDir),
    task: inputs.taskOf(entry.name),
    report: inputs.reportOf(entry.name),
    context: contextOf(entry, line),
    cost: line?.costUsd == null ? null : { usd: line.costUsd, atMs: line.writtenAtMs },
  };
}

function shown(entry: RosterEntry, nowMs: number): boolean {
  if (entry.presence !== "exited") return true;
  return entry.exitedAtMs !== null && nowMs - entry.exitedAtMs <= EXITED_SHOWN_MS;
}

function byPresenceThenNewest(a: RosterEntry, b: RosterEntry): number {
  return PRESENCE_ORDER[a.presence] - PRESENCE_ORDER[b.presence] || b.spawnedAtMs - a.spawnedAtMs;
}

function accountStrip(usage: AccountUsage, agents: readonly AgentRow[], nowMs: number): AccountStrip {
  const chips = new Set(usage.configDirs.map(accountChip));
  const account = usage.configDirs.map(accountChip).find((chip) => agents.some((a) => a.account === chip)) ?? accountChip(usage.configDirs[0] ?? null);
  return {
    account,
    agents: agents.filter((a) => a.presence !== "exited" && a.account !== null && chips.has(a.account)).length,
    fiveHour: usage.fiveHour,
    sevenDay: usage.sevenDay,
    readAtMs: usage.ageSeconds === null ? null : nowMs - usage.ageSeconds * 1000,
    stale: usage.stale,
    authFail: usage.authFail,
  };
}

/** Accounts running agents first, busiest first; an account with no reading and no agent is left out. */
function accountStrips(accounts: readonly AccountUsage[], agents: readonly AgentRow[], nowMs: number): AccountStrip[] {
  return accounts
    .map((usage) => accountStrip(usage, agents, nowMs))
    .filter((strip) => strip.agents > 0 || strip.readAtMs !== null)
    .sort((a, b) => b.agents - a.agents || a.account.localeCompare(b.account));
}

export function buildSnapshot(inputs: SnapshotInputs): Snapshot {
  const agents = inputs.roster
    .filter((entry) => shown(entry, inputs.nowMs))
    .sort(byPresenceThenNewest)
    .map((entry) => agentRow(entry, inputs));
  return {
    atMs: inputs.nowMs,
    agents,
    accounts: accountStrips(inputs.accounts, agents, inputs.nowMs),
    slots: inputs.slots,
    errors: inputs.errors,
  };
}
