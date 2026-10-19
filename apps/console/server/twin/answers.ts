// Hand-written twin answers for the sources with no file fixture: the broker, the session graph, Shepherd, the
// inbox, repo reviews, the theater and the config reads. Every value is synthetic; each is typed by the command the page calls.
import type { ServedCommands } from "../../src/data/rpc.js";
import { TWIN_NOW } from "./clock.js";

type Served = ServedCommands;
export type TwinCommand = keyof Served & string;

/** One recorded call. Its args and result are the command's own types, so a fixture that drifts fails typecheck. */
export interface TwinCall<K extends TwinCommand = TwinCommand> {
  command: K;
  args: Served[K]["args"];
  result: Served[K]["result"];
}

export const answer = <K extends TwinCommand>(command: K, args: Served[K]["args"], result: Served[K]["result"]): TwinCall<K> => ({ command, args, result });

/** A call the real command answers at capture time; its args are still checked against the command's own. */
export const recorded = <K extends TwinCommand>(command: K, args: Served[K]["args"]): Pick<TwinCall<K>, "command" | "args"> => ({ command, args });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (msAgo: number): string => new Date(TWIN_NOW - msAgo).toISOString();
const HEAD = "0b7e2c1a5d4f4e8b9a1c3d5e7f9b0a2c4e6d8f01";

type RosterEntry = Served["agents.roster"]["result"]["agents"][number];

function agent(name: string, overrides: Partial<RosterEntry>): RosterEntry {
  return {
    id: `name:${name}`, idSource: "nameAtRegisteredAt", name, agentId: null, state: "working", stateSource: "presence", origin: "spawned",
    workingOn: null, cwd: "/synthetic/orbit-relay", gitBranch: null, seat: null, surface: "headless", profile: "implementer", taskId: null,
    spawnedBy: "orbit-coord", claudeSessionId: null, registeredAt: TWIN_NOW - 2 * HOUR, spawnedAt: TWIN_NOW - 2 * HOUR, lastEventAt: TWIN_NOW - 4 * MINUTE,
    idleMs: 4 * MINUTE, dnd: false, provisional: false, tags: [], costUsd: null, costSource: null,
    ...overrides,
  };
}

const ROSTER = [
  agent("orbit-coord", { origin: "adopted", spawnedBy: null, surface: "terminal", profile: "coordinator", workingOn: "Coordinating the relay retry slice", costUsd: 4.12, costSource: "session-analytics" }),
  agent("relay-builder", { taskId: "OR-12", gitBranch: "feat/or-12-retry", workingOn: "OR-12: retry a dropped handshake with backoff", costUsd: 1.37, costSource: "session-analytics" }),
  agent("queue-probe", { state: "blocked", taskId: "OR-14", workingOn: "OR-14: waiting on a port decision", idleMs: 40 * MINUTE }),
  agent("docs-scribe", { state: "exited", stateSource: "history", taskId: "LD-3", idleMs: null, lastEventAt: TWIN_NOW - 5 * HOUR, costUsd: 0.62, costSource: "exit-report" }),
];

const HISTORY = { events: 6, limit: 1000, oldestAt: TWIN_NOW - 6 * HOUR };

function message(id: number, from: string, to: string | null, text: string, minutesAgo: number, kind = "message") {
  return { id, msgId: `msg-${id}`, kind, from, to, text, at: TWIN_NOW - minutesAgo * MINUTE, ref: null, meta: {} };
}

const MESSAGES = [
  message(6, "queue-probe", "human", "Which port should the depth probe listen on?", 40, "question"),
  message(5, "relay-builder", "orbit-coord", "Backoff lands; tests green locally.", 12),
  message(4, "orbit-coord", "relay-builder", "Cap the backoff at thirty seconds, per the decision note.", 50),
  message(3, "docs-scribe", "orbit-coord", "Battery chapters merged; PR open.", 300),
];

const QUEUE = {
  items: [{ msgId: "msg-6", kind: "question", asker: "queue-probe", text: "Which port should the depth probe listen on?", at: TWIN_NOW - 40 * MINUTE, ageMs: 40 * MINUTE, options: ["7410", "7420"], recommended: "7410", meta: {} }],
  hidden: { notice: 2 },
  open: 1,
  generatedAt: TWIN_NOW,
};

type SessionRow = Served["sessions.list"]["result"]["sessions"][number];

function session(sessionId: string, title: string, startedAgo: number, overrides: Partial<SessionRow>): SessionRow {
  return {
    sessionId, title, startedAt: at(startedAgo), endedAt: at(startedAgo - 40 * MINUTE), cwd: "/synthetic/orbit-relay", gitBranch: null, turnCount: 18,
    transcript: { path: `~/synthetic/${sessionId}.jsonl`, status: "indexed" }, agentName: null, parentSessionId: null, taskIds: [], prs: [],
    usage: [{ model: "claude-opus-5-5", inputTokens: 12_400, cacheReadTokens: 310_000, cacheCreationTokens: 22_000, outputTokens: 8_100, requests: 18, costUsd: 1.37, priced: true }],
    costUsd: 1.37,
    ...overrides,
  };
}

const SESSIONS = [
  session("relay-retry", "Handshake retry spike", 2 * HOUR, { agentName: "relay-builder", gitBranch: "feat/or-12-retry", taskIds: ["OR-12"], prs: ["pr:orbit/relay#12"] }),
  session("queue-depth", "Queue depth probe", 5 * HOUR, { agentName: "queue-probe", taskIds: ["OR-14"], turnCount: 7, costUsd: 0.41 }),
  session("chapter-merge", "Merge the battery chapters", 26 * HOUR, { agentName: "docs-scribe", taskIds: ["LD-3"], cwd: "/synthetic/lantern-docs", costUsd: 0.62 }),
];

type InboxItem = Served["inbox.list"]["result"]["items"][number];

function inboxItem(id: string, overrides: Partial<InboxItem> & Pick<InboxItem, "action">): InboxItem {
  return {
    id, sources: [{ system: "hitl", ref: `run-${id}/approve-merge` }], kind: "approve", door: "one-way", summary: `Summary of ${id}`, context: "", keys: [],
    personal: false, lens: "blocking-merge", unblocks: [], openedAt: at(HOUR), status: "open", section: "blocking", evidence: undefined,
    ...overrides,
  };
}

const INBOX_ITEMS = [
  inboxItem("gate-12", {
    summary: "Merge orbit/relay#12", openedAt: at(2 * HOUR), evidence: "#/shepherd/orbit%2Frelay%2312",
    options: [{ id: "merge", label: "merge" }, { id: "hold", label: "hold" }], recommended: { optionId: "merge", by: "relay-reviewer" },
    action: { kind: "resolve-gate", gateId: "run-12/approve-merge", runId: "run-12", stepId: "approve-merge", repo: "orbit/relay", pr: 12, headSha: HEAD, decision: "merge" },
  }),
  inboxItem("ask-6", { sources: [{ system: "agent-chat", ref: "msg-6" }], kind: "decide", lens: "blocking-agent", summary: "Which port should the depth probe listen on?", openedAt: at(40 * MINUTE), action: { kind: "answer-chat", msgId: "msg-6" } }),
  inboxItem("round-ship", { sources: [{ system: "round", ref: "ship-tile-r1" }], kind: "review", summary: "Ship tile frames", openedAt: at(5 * HOUR), evidence: "#/rounds/ship-tile-r1", action: { kind: "open-round", roundId: "ship-tile-r1" } }),
  inboxItem("task-or-9", { sources: [{ system: "active-work", ref: "orbit-relay/OR-9" }], kind: "decide", lens: "planning", section: "planning", summary: "Plan OR-9", evidence: "#/tasks/OR-9", action: { kind: "open", route: "#/tasks/OR-9" } }),
];

type WatchRow = Served["shepherd.list"]["result"][number];

function watch(pr: number, phase: string, overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    repo: "orbit/relay", pr, branch: `feat/or-${pr}`, runId: `run-${pr}`, task: `orbit-relay/OR-${pr}`, phase, headSha: HEAD, phaseSince: at(25 * MINUTE),
    nextAction: "wait for CI", pendingGate: null, held: null, stalled: null,
    ...overrides,
  };
}

const WATCHED = [
  watch(12, "awaiting-merge", { nextAction: "owner approves the merge", pendingGate: { gateId: "run-12/approve-merge", stepId: "approve-merge", since: at(2 * HOUR) } }),
  watch(14, "ci", { phaseSince: at(9 * MINUTE) }),
  watch(9, "review", { stalled: { reason: "no reviewer verdict in 3h" }, phaseSince: at(3 * HOUR) }),
];

const INBOX_DERIVED: Served["inbox.list"]["result"]["derived"] = [
  {
    id: "derived:stalled-run:run-9", kind: "stalled-run", summary: "orbit/relay#9 is stalled in review", link: "#/shepherd/orbit%2Frelay%239",
    evidence: { observed: "stalled: no reviewer verdict in 3h", source: "shepherd row run-9", at: at(3 * HOUR) },
    threshold: { name: "Shepherd stall verdict, phase older than 15 min", limitMs: 15 * MINUTE, ageMs: 3 * HOUR },
  },
];

const TIMELINE_ENTRIES = [
  { kind: "step", stepId: "sh-ci", iteration: 1, startedAt: at(3 * HOUR), completedAt: at(3 * HOUR - 10 * MINUTE), signal: null, status: "done" },
  { kind: "verdict", stepId: "sh-review", verdict: "MERGE", headSha: HEAD.slice(0, 16), locator: null, reviewer: "relay-reviewer" },
];

type ReviewSummary = Served["reviews.list"]["result"]["reviews"][number];

function review(name: string, overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    name, remote: `https://example.com/acme/${name}`, head: HEAD, readmeStatus: null, label: "final", state: "final", p1: 1, p2: 2, topics: 4, claims: 2, unread: 0,
    cost: { usd: 1.5, calls: 3, errors: 0, lastTs: at(30 * HOUR) },
    ...overrides,
  };
}

const REVIEW_MARKDOWN = `# widget-kit against the platform

## Short answer

The widget kit's layout engine is already covered; its theme tokens are worth a crib.

## Recommendations

1. **Theme tokens (WK-1).** Adopt the token naming.
`;

const topic = (topic_id: string, priority: string, verdict: string, line: number) => ({ topic_id, tier: "core", title: `Topic ${topic_id}`, verdict, priority, titan_evidence: "", reason: `Why ${topic_id}`, line, extra: {} });

type TaskRow = Served["work.tasks"]["result"]["tasks"][number];

function task(id: string, title: string, overrides: Partial<TaskRow>): TaskRow {
  return {
    slug: "orbit-relay", id, title, priority: 1, severity: "high", updated: "2031-03-04", status: "open", stage: "ready", stageRule: "default",
    stageReason: "No branch, pull request or dependency names this task", stageGuessed: true, parent: null, dep: [], deliverables: [],
    ...overrides,
  };
}

const TASKS = [
  task("OR-12", "Retry a dropped handshake with backoff", { severity: "critical", estimate: 2, tags: ["transport"], stage: "review", stageRule: "open-pr", stageReason: "orbit/relay#12 is open", stageGuessed: false }),
  task("OR-14", "Report queue depth per station", { priority: 2, estimate: 1, stage: "in-progress", stageRule: "live-ref", stageReason: "Branch feat/or-14 is live", stageGuessed: false }),
  task("OR-9", "Document the routing table format", { priority: 3, severity: "low", updated: "2031-02-20", stage: "blocked", stageRule: "dependency", stageReason: "Waits on OR-12", stageGuessed: false, dep: ["OR-12"] }),
  task("LD-3", "Merge the two battery chapters", { slug: "lantern-docs", severity: "medium", estimate: 3, updated: "2031-03-01" }),
];

const EVIDENCE = { repos: ["orbit/relay"], degraded: [] };

const TASK_DETAIL: Served["work.task"]["result"] = {
  fetchedAt: new Date(TWIN_NOW).toISOString(),
  task: { ...TASKS[0]!, doneWhen: "A dropped handshake retries with capped backoff and a test drops it twice" },
  mentions: [],
  artifacts: { branches: [], worktrees: [] },
  refs: [],
  openPrs: [],
  sessions: [],
  sessionsDegraded: null,
  evidence: EVIDENCE,
  children: [],
  deliverables: [],
  deliverablesDegraded: null,
};

const VIDEO = { id: "v-relay-intro", title: "Relay intro", group: "orbit-relay", bytes: 4_200_000, modifiedAt: at(3 * HOUR), captions: true, renderNotes: false,
  durationS: 42.5, width: 1920, height: 1080, orientation: "landscape", audio: true, copies: 0, superseded: false,
} as const;

const VIDEO_NOTE = {
  schema: "titan-console/video-note@1", id: "0123456789abcdef", videoId: VIDEO.id, video: "relay-intro.mp4", renderSha256: "ab".repeat(32),
  atS: 12.5, createdAt: at(2 * HOUR), kind: "comment", text: "Hold the title card a beat longer", current: true,
} as const;

const SEAT_FILE = "/synthetic/autonomy/seats/relay-seat.md";
const AGENT_CHAT_FILE = "/synthetic/agent-chat/config.json";

function configFile(surface: string, kind: string, group: Served["config.surfaces"]["result"]["files"][number]["group"], file: string) {
  return { surface, kind, group, inventory: 1, file, mtime: at(6 * HOUR), newestBackup: null };
}

const CONFIG_SURFACES: Served["config.surfaces"]["result"] = {
  files: [configFile("seat:relay-seat", "seat", "coordinator", SEAT_FILE), configFile("agent-chat-config", "agent-chat-config", "agent-chat", AGENT_CHAT_FILE)],
  rows: [
    { surface: "seat:relay-seat", file: SEAT_FILE, field: "concurrency.implementers", line: 12, hidden: false, value: 6, comment: "owner decision 12", decisions: ["12"] },
    { surface: "seat:relay-seat", file: SEAT_FILE, field: "notify_token", line: 14, hidden: true, decisions: [] },
    { surface: "agent-chat-config", file: AGENT_CHAT_FILE, field: "worktreeBudget", line: 3, hidden: false, value: 8, decisions: [] },
  ],
  gaps: ["/synthetic/factory/config.json: missing"],
};

const CONFIG_DRIFT: Served["config.drift"]["result"] = {
  rows: [
    {
      id: "worktrees-per-repo", label: "Worktree cap per repo", status: "drift", values: [8, 10],
      sources: [
        { surface: "agent-chat-config", field: "worktreeBudget", file: AGENT_CHAT_FILE, line: 3, value: 8 },
        { surface: "burndown", field: "maxWorktreesPerRepo", file: "/synthetic/agent-chat/burndown.config.json", line: 4, value: 10 },
      ],
      absent: [],
    },
  ],
  gaps: [],
};

const CONFIG_HOSTS: Served["config.hosts"]["result"] = {
  hosts: [
    {
      host: "relay-mini", status: "reported", reportedAt: at(3 * HOUR), receivedAt: at(3 * HOUR), platform: "darwin",
      surfaces: [{ kind: "agent-chat-config", inventory: 2, file: "~/synthetic/agent-chat/config.json", present: true, secret: false, mode: "0644", bytes: 512, mtime: at(6 * HOUR), sha256: "cd".repeat(32) }],
    },
    { host: "relay-spare", status: "not reported", reportedAt: at(40 * HOUR), receivedAt: at(40 * HOUR), platform: "linux", surfaces: [] },
  ],
  gaps: [],
};

/** The answers for every source the file fixtures do not cover. */
export const HAND_ANSWERS: readonly TwinCall[] = [
  answer("upstreams.health", {}, {
    checkedAt: new Date(TWIN_NOW).toISOString(),
    upstreams: [
      { id: "work", label: "active-work daemon", target: "http://127.0.0.1:7400", reachable: true, detail: "Version 1.2.3" },
      { id: "agents", label: "agent-chat broker", target: "http://127.0.0.1:7600", reachable: true, detail: "Version 0.9.0" },
      { id: "sessions", label: "session graph", target: "~/synthetic/graph.sqlite3", reachable: true, detail: "2.0 KiB on disk, not opened" },
    ],
  }),
  answer("agents.roster", {}, { agents: ROSTER, brokerUptimeMs: 6 * HOUR, reconnecting: false, history: HISTORY, generatedAt: TWIN_NOW }),
  answer("agents.queue", {}, QUEUE),
  answer("agents.messages", { limit: 200 }, { messages: MESSAGES, source: "events-db", partial: false, nextCursor: null, history: null }),
  answer("agents.messages", { agent: "relay-builder", limit: 200 }, { messages: MESSAGES.filter((m) => m.from === "relay-builder" || m.to === "relay-builder"), source: "events-db", partial: false, nextCursor: null, history: null }),
  answer("sessions.list", { limit: 200 }, { sessions: SESSIONS, nextBefore: null, degraded: null }),
  answer("sessions.list", { limit: 50 }, { sessions: SESSIONS, nextBefore: null, degraded: null }),
  answer("sessions.list", { agent: "relay-builder", limit: 50 }, { sessions: SESSIONS.slice(0, 1), nextBefore: null, degraded: null }),
  answer("sessions.timeline", { sessionId: "relay-retry" }, { status: "degraded", sessionId: "relay-retry", degraded: { reason: "transcript-missing", detail: "The twin carries no transcript" }, session: SESSIONS[0]! }),
  answer("work.tasks", {}, { fetchedAt: new Date(TWIN_NOW).toISOString(), tasks: TASKS, evidence: EVIDENCE }),
  answer("work.task", { id: "OR-12" }, TASK_DETAIL),
  answer("inbox.list", {}, { items: INBOX_ITEMS, gaps: [], fyiCount: 3, readAt: new Date(TWIN_NOW).toISOString(), derived: INBOX_DERIVED }),
  answer("shepherd.list", { state: "active" }, WATCHED),
  answer("shepherd.waiting", {}, { owner: [{ gateId: "run-12/approve-merge", stepId: "approve-merge", repo: "orbit/relay", pr: 12, task: "orbit-relay/OR-12", since: at(2 * HOUR), ageHours: 2 }], seat: [] }),
  answer("shepherd.timeline", { repo: "orbit/relay", pr: 12 }, { row: WATCHED[0]!, entries: TIMELINE_ENTRIES }),
  answer("reviews.list", {}, { reviews: [review("widget-kit"), review("orbit-cli", { state: "pinned", label: null, cost: null })], gaps: [], readAt: new Date(TWIN_NOW).toISOString() }),
  answer("reviews.get", { name: "widget-kit" }, {
    review: review("widget-kit"),
    summary: { markdown: REVIEW_MARKDOWN, truncated: false, bytes: REVIEW_MARKDOWN.length },
    coverage: "12 of 12 files read",
    recommendations: [{ id: "WK-1", source: "recommendation", line: 9 }],
    topics: [topic("WK-1", "P2", "missing", 2), topic("WK-2", "P1", "already-have", 3), topic("WK-3", "P3", "have-worse", 4)],
    claims: [{ id: "WK-C1", source: "README.md", status: "verified", evidence: "src/layout.ts:L1-L20", claim: "Layout is constraint-based", line: 2 }],
    gaps: [],
    readAt: new Date(TWIN_NOW).toISOString(),
  }),
  answer("videos.list", {}, { videos: [{ ...VIDEO, noteCount: 1, openNoteCount: 1, verdict: null }], truncated: false, gaps: [] }),
  answer("videos.notes", { videoId: VIDEO.id }, { video: VIDEO.id, notes: [VIDEO_NOTE], verdict: null, gaps: [] }),
  answer("config.surfaces", {}, CONFIG_SURFACES),
  answer("config.drift", {}, CONFIG_DRIFT),
  answer("config.hosts", {}, CONFIG_HOSTS),
];
