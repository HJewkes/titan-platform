/**
 * Per-RPC budgets for the console's reads against the synthetic large-state fixture (TP-4403 §3d, d1). One table, so CI's
 * budgets.perf.test and the perf view's warning badges judge an RPC by the same numbers.
 *
 * Bytes and upstream calls are deterministic and set a little above what main measures today. Wall time is noisy, so
 * `maxMs` is about 4x today's local median, rounded up to 50 ms. A fix that cuts an RPC's cost tightens its own row.
 */
export interface RpcBudget {
  rpc: string;
  /** Arguments that name data the fixture holds, so the read does its full work. */
  args: Record<string, unknown>;
  /** Median of the timed runs, in ms. */
  maxMs: number;
  /** `JSON.stringify(envelope).length`. */
  maxBytes: number;
  /** Upstream calls a fresh registry makes on its first call. */
  maxUpstreamCalls: number;
  /** Upstream calls on the next call, where a read caches; unset means the same as `maxUpstreamCalls`. */
  maxUpstreamCallsWarm?: number;
  /** Why the fixture cannot answer this read, which then budgets its refusal instead of its answer. */
  fixtureGap?: string;
}

type Limits = Omit<RpcBudget, "rpc" | "args" | "fixtureGap">;

const KB = 1024;

/** A read with no row of its own still gets one with these limits, so a new read is checked from the start. */
export const DEFAULT_LIMITS: Limits = { maxMs: 200, maxBytes: 256 * KB, maxUpstreamCalls: 2 };

const NO_FAKE_ANSWER = "the fake factory has no answer for it";
const NO_VIDEO_ROOTS = "the fixture sets no video roots";
const NO_MEDIA = "the fixture's rounds hold frames JSON but no media or targets";

function row(rpc: string, args: Record<string, unknown> = {}, limits: Partial<Limits> = {}, fixtureGap?: string): RpcBudget {
  return { rpc, args, ...DEFAULT_LIMITS, ...limits, ...(fixtureGap && { fixtureGap }) };
}

const ROUND = "perf-round-0000";
const RUN = { repo: "example-org/repo-24", pr: 1000 };

/** The coord rows read a day with 80 merged runs (factory.fixture.ts): cold, one timeline call each besides the list (and, for cards, the task list); warm, the cached merge times need none. */
export const RPC_BUDGETS: readonly RpcBudget[] = [
  row("agents.graph", {}, { maxBytes: 13 * KB }),
  row("agents.messages", {}, { maxBytes: 52 * KB, maxUpstreamCalls: 0 }),
  row("agents.queue", {}, { maxBytes: 12 * KB, maxUpstreamCalls: 1 }),
  row("agents.roster", {}, { maxBytes: 35 * KB }),
  row("approvals.flow", {}, { maxMs: 3950, maxBytes: 960 * KB, maxUpstreamCalls: 1 }),
  row("autoresearch.diff", { runId: "ar-000", ideaId: "idea-0" }, { maxUpstreamCalls: 1 }, NO_FAKE_ANSWER),
  row("autoresearch.run", { runId: "ar-000" }, { maxUpstreamCalls: 1 }, NO_FAKE_ANSWER),
  row("autoresearch.runs", {}, { maxBytes: 6 * KB, maxUpstreamCalls: 1 }),
  row("blockers.banner", {}, { maxMs: 200, maxBytes: 4 * KB, maxUpstreamCalls: 1 }),
  row("config.compareTree"),
  row("config.drift"),
  row("config.hosts"),
  row("config.surfaces"),
  row("console.build"),
  row("coord.cards", { date: "2031-01-01" }, { maxBytes: 12 * KB, maxUpstreamCalls: 82, maxUpstreamCallsWarm: 2 }),
  row("coord.pools", {}, { maxBytes: 4 * KB, maxUpstreamCalls: 0 }),
  row("coord.shipped", { date: "2031-01-01" }, { maxBytes: 12 * KB, maxUpstreamCalls: 81, maxUpstreamCallsWarm: 1 }),
  row("gates.strip", RUN, { maxBytes: 1 * KB, maxUpstreamCalls: 4 }),
  row("graph.ego", { ref: "task:AA-1" }, { maxBytes: 1 * KB, maxUpstreamCalls: 1 }),
  row("inbox.list", {}, { maxMs: 4200, maxBytes: 150 * KB, maxUpstreamCalls: 5, maxUpstreamCallsWarm: 3 }),
  row("inbox.prepare", { itemId: `round:${ROUND}/q1` }, { maxUpstreamCalls: 0 }, "the fixture leaves inbox actions off"),
  row("rounds.frame", { id: ROUND, key: "frame-0" }, { maxUpstreamCalls: 0 }, NO_MEDIA),
  row("rounds.frameDelta", { id: ROUND, key: "frame-0" }, { maxUpstreamCalls: 0 }, NO_MEDIA),
  row("rounds.frames", { id: ROUND }, { maxBytes: 1 * KB, maxUpstreamCalls: 0 }),
  row("rounds.frameTargets", { id: ROUND, key: "frame-0" }, { maxUpstreamCalls: 0 }, NO_MEDIA),
  row("rounds.get", { id: ROUND }, { maxBytes: 1 * KB, maxUpstreamCalls: 0 }),
  row("rounds.list", {}, { maxMs: 350, maxBytes: 112 * KB, maxUpstreamCalls: 0 }),
  row("sessions.list"),
  row("sessions.timeline", { sessionId: "perf-session" }, { maxMs: 850 }),
  row("shepherd.list", {}, { maxBytes: 136 * KB, maxUpstreamCalls: 1 }),
  row("shepherd.timeline", RUN, { maxUpstreamCalls: 1 }, NO_FAKE_ANSWER),
  row("shepherd.waiting", {}, { maxUpstreamCalls: 1 }, NO_FAKE_ANSWER),
  row("taps.prepare", { target: { kind: "retire-agent", name: "perf-agent" } }, { maxUpstreamCalls: 0 }, "the fixture leaves inbox actions off"),
  row("upstreams.health", {}, { maxUpstreamCalls: 1 }),
  row("videos.edit-check", { videoId: "perf-video", runId: "perf-run" }, {}, NO_VIDEO_ROOTS),
  row("videos.edits", { videoId: "perf-video" }, {}, NO_VIDEO_ROOTS),
  row("videos.list"),
  row("videos.notes", { videoId: "perf-video" }, {}, NO_VIDEO_ROOTS),
  row("videos.props", { videoId: "perf-video" }, {}, NO_VIDEO_ROOTS),
  row("videos.resolve", { alias: "perf-alias" }),
  row("work.initiative", { slug: "amber-00" }, { maxBytes: 46 * KB, maxUpstreamCalls: 8 }),
  row("work.notes", {}, { maxBytes: 600 * KB }),
  row("work.portfolio", {}, { maxMs: 250, maxBytes: 20 * KB, maxUpstreamCalls: 48 }),
  row("work.record", { ref: "note:harbor-27/2031-01-01-nectar-021.md" }, { maxBytes: 2 * KB, maxUpstreamCalls: 1 }),
  row("work.search", { q: "onyx" }, { maxBytes: 9 * KB, maxUpstreamCalls: 1 }),
  row("work.task", { id: "AA-1" }, { maxMs: 9800, maxBytes: 1 * KB, maxUpstreamCalls: 4 }),
  row("work.taskArtifacts", { id: "AA-1", slug: "amber-00" }, { maxBytes: 1 * KB, maxUpstreamCalls: 1 }),
  row("work.taskMentions", { id: "AA-1" }, { maxBytes: 1 * KB, maxUpstreamCalls: 1 }),
  row("work.tasks", {}, { maxMs: 9700, maxBytes: 12 * KB }),
];

export function budgetFor(rpc: string): RpcBudget | undefined {
  return RPC_BUDGETS.find((budget) => budget.rpc === rpc);
}
