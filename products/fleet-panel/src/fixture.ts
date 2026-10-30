// Synthetic broker output for tests and screenshots: invented agents, accounts and paths only.
import { EventBook, SseParser } from "./events.js";
import { parseAccounts, parseRoster, parseSlots, parseStatusLine, type StatusLineReading } from "./inputs.js";
import { buildSnapshot, type Snapshot } from "./snapshot.js";

export const NOW_MS = Date.parse("2026-01-15T12:00:00Z");
const ago = (minutes: number) => new Date(NOW_MS - minutes * 60_000).toISOString();

export const ROSTER_JSON = JSON.stringify([
  {
    name: "builder-a",
    presence: "live",
    profile: "implementer",
    model: "claude-opus-5-5",
    sessionId: "s-builder-a",
    account: "/home/you/.claude-profiles/acct-a",
    spawnedAt: ago(40),
    contextK: 88,
  },
  {
    name: "reviewer-b",
    presence: "live",
    profile: "reviewer",
    model: "claude-sonnet-5-5",
    sessionId: "s-reviewer-b",
    account: "/home/you/.claude-profiles/acct-b",
    spawnedAt: ago(12),
    contextK: null,
  },
  {
    name: "planner-c",
    presence: "detached",
    profile: "planner",
    model: null,
    sessionId: "s-planner-c",
    account: "/home/you/.claude",
    spawnedAt: ago(90),
    contextK: 140,
  },
  {
    name: "fixer-d",
    presence: "exited",
    profile: "implementer",
    model: "claude-opus-5-5",
    sessionId: "s-fixer-d",
    account: "/home/you/.claude-profiles/acct-a",
    spawnedAt: ago(70),
    exitedAt: ago(5),
    contextK: 120,
  },
  {
    name: "old-e",
    presence: "exited",
    profile: "implementer",
    model: "claude-haiku-5-5",
    sessionId: "s-old-e",
    account: "/home/you/.claude-profiles/acct-b",
    spawnedAt: ago(300),
    exitedAt: ago(200),
    contextK: 20,
  },
]);

export const ACCOUNTS_JSON = JSON.stringify([
  {
    account: "acct-a-login",
    config_dir: "/home/you/.claude-profiles/acct-a",
    config_dirs: ["/home/you/.claude-profiles/acct-a"],
    source: "usage-poller",
    five_hour: { used_pct: 62, resets_at: (NOW_MS + 80 * 60_000) / 1000 },
    seven_day: { used_pct: 21, resets_at: (NOW_MS + 3 * 86_400_000) / 1000 },
    age_seconds: 40,
    stale: false,
    auth_fail: false,
  },
  {
    account: "acct-b-login",
    config_dir: "/home/you/.claude-profiles/acct-b",
    config_dirs: ["/home/you/.claude-profiles/acct-b"],
    source: "status-line",
    five_hour: { used_pct: 91 },
    seven_day: { used_pct: 40 },
    age_seconds: 1_100,
    stale: true,
    auth_fail: false,
  },
  {
    account: "default-login",
    config_dir: "/home/you/.claude",
    config_dirs: ["/home/you/.claude"],
    source: null,
    five_hour: null,
    seven_day: null,
    age_seconds: null,
    stale: false,
    auth_fail: false,
  },
]);

export const STATUS_LINES: Record<string, string> = {
  "s-builder-a": JSON.stringify({ written_at: (NOW_MS - 20_000) / 1000, context: { used_pct: 44 }, cost: { total_cost_usd: 4.1 } }),
  "s-planner-c": JSON.stringify({ written_at: (NOW_MS - 30 * 60_000) / 1000, context: { used_pct: 71 }, cost: { total_cost_usd: 12.5 } }),
};

export const HEALTH_JSON = JSON.stringify({ ok: true, slots: { held: 3, cap: 12 } });

interface FixtureRow {
  id: number;
  minutesAgo: number;
  kind: string;
  actor: string;
  target: string;
  body: string;
  meta?: Record<string, string>;
}

/** One `/events` frame in the broker's own layout. */
function frame({ id, minutesAgo, kind, actor, target, body, meta = {} }: FixtureRow): string {
  const data = { id, ts: NOW_MS - minutesAgo * 60_000, kind, actor, target, msgId: `m${id}`, ref: null, body, meta };
  return `id: ${id}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** `/events` frames as the broker writes them, heartbeat included. */
export const EVENT_STREAM = [
  ": heartbeat\n\n",
  frame({ id: 7, minutesAgo: 40, kind: "agent_spawned", actor: "lead", target: "builder-a", body: "brief", meta: { name: "builder-a", task: "DEMO-12" } }),
  frame({ id: 8, minutesAgo: 3, kind: "message", actor: "builder-a", target: "lead", body: "Status: DONE\nPR: example/repo#41\nHead: abc" }),
  frame({ id: 9, minutesAgo: 1, kind: "message", actor: "reviewer-b", target: "builder-a", body: "looking now" }),
  frame({ id: 10, minutesAgo: 8, kind: "message", actor: "fixer-d", target: "lead", body: "Status: BLOCKED\nPR: none" }),
].join("");

export function fixtureBook(): EventBook {
  const book = new EventBook();
  for (const frame of new SseParser().push(EVENT_STREAM)) book.accept(frame);
  return book;
}

export function fixtureSnapshot(errors: string[] = []): Snapshot {
  const book = fixtureBook();
  const statusLines = new Map<string, StatusLineReading>();
  for (const [sessionId, text] of Object.entries(STATUS_LINES)) {
    const reading = parseStatusLine(text);
    if (reading) statusLines.set(sessionId, reading);
  }
  return buildSnapshot({
    nowMs: NOW_MS,
    roster: parseRoster(ROSTER_JSON),
    accounts: parseAccounts(ACCOUNTS_JSON),
    statusLines,
    reportOf: (name) => book.reportOf(name),
    taskOf: (name) => book.taskOf(name),
    slots: parseSlots(HEALTH_JSON),
    errors,
  });
}
