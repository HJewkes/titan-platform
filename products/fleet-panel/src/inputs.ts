/**
 * The shapes the feed reads from agent-chat, and guards that take only the fields it uses.
 * agent-chat owns these formats; a field missing or of the wrong type reads as absent rather
 * than failing the whole roster, because one odd row must not blank the panel.
 */

import type { AccountUsage as AccountRow, AccountWindow } from "@titan-design/anthropic-account";

export type Presence = "live" | "detached" | "exited";

/** One row of `agent-chat agent ls --json`. */
export interface RosterEntry {
  name: string;
  presence: Presence;
  profile: string;
  model: string | null;
  sessionId: string;
  /** The Claude config dir the agent runs under, which names its account. */
  configDir: string | null;
  spawnedAtMs: number;
  exitedAtMs: number | null;
  /** Context in thousands of tokens, read from the transcript; null when unread. */
  contextK: number | null;
}

/** One rate-limit window as Claude Code reports it. */
export interface UsageWindow {
  usedPct: number;
  resetsAtMs: number | null;
}

/** One Anthropic login, as `readAccounts` reports it. */
export interface AccountUsage {
  configDirs: string[];
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** Null when nothing has written a reading for this account. */
  ageSeconds: number | null;
  stale: boolean;
  authFail: boolean;
}

/** What one session's status line last wrote to its status cache. */
export interface StatusLineReading {
  writtenAtMs: number;
  contextPct: number | null;
  costUsd: number | null;
}

export interface Slots {
  held: number;
  cap: number;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const timeMs = (value: unknown): number | null => {
  const text = str(value);
  const parsed = text === null ? Number.NaN : Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
};

const PRESENCES: readonly Presence[] = ["live", "detached", "exited"];

function rosterEntry(row: unknown): RosterEntry | null {
  if (!isObject(row)) return null;
  const name = str(row.name);
  const spawnedAtMs = timeMs(row.spawnedAt);
  if (name === null || spawnedAtMs === null) return null;
  const presence = PRESENCES.find((p) => p === row.presence) ?? "detached";
  return {
    name,
    presence,
    profile: str(row.profile) ?? "?",
    model: str(row.model),
    sessionId: str(row.sessionId) ?? "",
    configDir: str(row.account),
    spawnedAtMs,
    exitedAtMs: timeMs(row.exitedAt),
    contextK: num(row.contextK),
  };
}

export function parseRoster(stdout: string): RosterEntry[] {
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error("agent ls --json did not print an array");
  return rows.map(rosterEntry).filter((entry): entry is RosterEntry => entry !== null);
}

function usageWindow(window: AccountWindow | undefined): UsageWindow | null {
  if (window === undefined) return null;
  return { usedPct: window.used_pct, resetsAtMs: window.resets_at === undefined ? null : window.resets_at * 1000 };
}

/** The panel's view of one login's row from `readAccounts`. */
export function accountUsageOf(row: AccountRow): AccountUsage {
  return {
    configDirs: [...row.config_dirs],
    fiveHour: usageWindow(row.windows.five_hour),
    sevenDay: usageWindow(row.windows.seven_day),
    ageSeconds: row.age_seconds,
    stale: row.stale,
    authFail: row.auth_fail,
  };
}

export function parseStatusLine(text: string): StatusLineReading | null {
  const data: unknown = JSON.parse(text);
  if (!isObject(data)) return null;
  const writtenAt = num(data.written_at);
  if (writtenAt === null) return null;
  const context = isObject(data.context) ? data.context : {};
  const cost = isObject(data.cost) ? data.cost : {};
  return { writtenAtMs: writtenAt * 1000, contextPct: num(context.used_pct), costUsd: num(cost.total_cost_usd) };
}

export function parseSlots(body: string): Slots | null {
  const data: unknown = JSON.parse(body);
  if (!isObject(data) || !isObject(data.slots)) return null;
  const held = num(data.slots.held);
  const cap = num(data.slots.cap);
  return held === null || cap === null ? null : { held, cap };
}
