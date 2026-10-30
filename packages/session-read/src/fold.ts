import type { AuditEventKind } from "./audit-events.js";
import type { EventOf, SessionEvent } from "./events.js";

export interface SessionRow {
  sessionId: string;
  startedAt: string | null;
  endedAt: string | null;
  startType: string | null;
  cwd: string | null;
  gitBranch: string | null;
  aiTitle: string | null;
  seedPrompt: string | null;
  cliVersion: string | null;
  turnDelta: number;
  commitDelta: number;
  pushDelta: number;
}

export interface BranchRow {
  branchRef: string;
  repo: string | null;
  name: string;
  base: string | null;
  createdAt: string | null;
  deletedAt: string | null;
}

/** One transcript chunk's events, merged so that applying N chunks equals one whole-file pass. */
export interface TranscriptDelta {
  sessions: SessionRow[];
  turns: EventOf<"turn">[];
  facts: EventOf<"fact">[];
  spans: EventOf<"span">[];
  phases: EventOf<"phase">[];
  humanEdits: EventOf<"human_edit">[];
  fileCheckpoints: EventOf<"file_checkpoint">[];
  prs: EventOf<"pr">[];
  prMerges: EventOf<"pr_merge">[];
  prCreates: EventOf<"pr_create">[];
  reviewVerdicts: EventOf<"review_verdict">[];
  branches: BranchRow[];
  files: EventOf<"file">[];
  tasks: EventOf<"task">[];
  subagents: EventOf<"subagent">[];
  subagentTranscripts: EventOf<"subagent_transcript">[];
  artifacts: EventOf<"artifact">[];
  edges: EventOf<"edge">[];
  requests: EventOf<"request">[];
  toolCalls: EventOf<"tool_call">[];
  inbound: EventOf<"inbound">[];
  contextBlocks: EventOf<"context_block">[];
  compactions: EventOf<"compaction">[];
  queueOps: EventOf<"queue_op">[];
  signals: EventOf<"signal">[];
  costStates: EventOf<"cost_state">[];
}

function emptySession(sessionId: string): SessionRow {
  return { sessionId, startedAt: null, endedAt: null, startType: null, cwd: null, gitBranch: null, aiTitle: null, seedPrompt: null, cliVersion: null, turnDelta: 0, commitDelta: 0, pushDelta: 0 };
}

/**
 * Merge rules are chosen so chunk boundaries cannot change the answer:
 * timestamps take min/max, counters sum, `gitBranch` and `seedPrompt` are
 * first-wins, `aiTitle`/`cwd`/`cliVersion` are last-wins, `startType` follows
 * the earliest line that carries an entrypoint, and ref-keyed rows dedupe.
 */
export class EventFolder {
  private readonly sessions = new Map<string, SessionRow>();
  private readonly startTypeAt = new Map<string, string>();
  private readonly branches = new Map<string, BranchRow>();
  private readonly byKey = new Map<string, Map<string, SessionEvent>>();
  private readonly lists = new Map<string, SessionEvent[]>();

  fold(event: SessionEvent): void {
    this.touchSession(event);
    switch (event.kind) {
      case "session":
        return this.foldSession(event);
      case "branch":
        return this.foldBranch(event);
      case "turn":
        return this.keyed("turns", event.promptId, event);
      case "pr":
        return this.keyed("prs", event.prRef, event);
      case "file":
        return this.keyed("files", event.fileRef, event);
      case "task":
        return this.foldTask(event);
      case "subagent":
        return this.keyed("subagents", event.agentRef, event);
      case "subagent_transcript":
        return this.keyed("subagentTranscripts", event.agentRef, event);
      case "artifact":
        return this.keyed("artifacts", event.artifactRef, event);
      case "edge":
        return this.keyed("edges", `${event.sourceRef}\0${event.relation}\0${event.targetRef}`, event);
      default:
        return this.append(LIST_OF[event.kind], event);
    }
  }

  result(): TranscriptDelta {
    const list = <K extends keyof typeof LIST_OF>(kind: K): EventOf<K>[] =>
      (this.lists.get(LIST_OF[kind]) ?? []).filter(isKind(kind));
    const keyed = <K extends SessionEvent["kind"]>(name: string, kind: K): EventOf<K>[] =>
      [...(this.byKey.get(name)?.values() ?? [])].filter(isKind(kind));
    return {
      sessions: [...this.sessions.values()],
      branches: [...this.branches.values()],
      turns: keyed("turns", "turn"),
      prs: keyed("prs", "pr"),
      files: keyed("files", "file"),
      tasks: keyed("tasks", "task"),
      subagents: keyed("subagents", "subagent"),
      subagentTranscripts: keyed("subagentTranscripts", "subagent_transcript"),
      artifacts: keyed("artifacts", "artifact"),
      edges: keyed("edges", "edge"),
      facts: list("fact"),
      spans: list("span"),
      phases: list("phase"),
      humanEdits: list("human_edit"),
      fileCheckpoints: list("file_checkpoint"),
      prMerges: list("pr_merge"),
      prCreates: list("pr_create"),
      reviewVerdicts: list("review_verdict"),
      requests: list("request"),
      toolCalls: list("tool_call"),
      inbound: list("inbound"),
      contextBlocks: list("context_block"),
      compactions: list("compaction"),
      queueOps: list("queue_op"),
      signals: list("signal"),
      costStates: list("cost_state"),
    };
  }

  private session(sessionId: string): SessionRow {
    let row = this.sessions.get(sessionId);
    if (!row) {
      row = emptySession(sessionId);
      this.sessions.set(sessionId, row);
    }
    return row;
  }

  private touchSession(event: SessionEvent): void {
    const row = this.session(event.sessionId);
    if (!event.ts) return;
    if (!row.startedAt || event.ts < row.startedAt) row.startedAt = event.ts;
    if (!row.endedAt || event.ts > row.endedAt) row.endedAt = event.ts;
  }

  private foldSession(event: EventOf<"session">): void {
    const row = this.session(event.sessionId);
    const { patch } = event;
    if (patch.cwd) row.cwd = patch.cwd;
    if (patch.cliVersion) row.cliVersion = patch.cliVersion;
    if (patch.aiTitle) row.aiTitle = patch.aiTitle;
    if (patch.gitBranch) row.gitBranch ??= patch.gitBranch;
    if (patch.seedPrompt) row.seedPrompt ??= patch.seedPrompt;
    row.turnDelta += event.turnDelta;
    row.commitDelta += event.commitDelta;
    row.pushDelta += event.pushDelta;
    if (patch.entrypoint && event.ts) this.foldStartType(row, event.ts, patch.entrypoint);
  }

  /** Earliest line that carries an entrypoint wins; the session's first line often has none. */
  private foldStartType(row: SessionRow, ts: string, entrypoint: string): void {
    const seenAt = this.startTypeAt.get(row.sessionId);
    if (seenAt !== undefined && seenAt <= ts) return;
    this.startTypeAt.set(row.sessionId, ts);
    row.startType = entrypoint;
  }

  /** Timestamps merge as min/max: a branch is seen from many chunks and many transcripts. */
  private foldBranch(event: EventOf<"branch">): void {
    const existing = this.branches.get(event.branchRef);
    const seenAt = event.ts || null;
    const merged: BranchRow = {
      branchRef: event.branchRef,
      repo: existing?.repo ?? event.repo,
      name: event.name,
      base: existing?.base ?? event.base,
      createdAt: event.deleted ? (existing?.createdAt ?? null) : earliest(existing?.createdAt, seenAt),
      deletedAt: event.deleted ? latest(existing?.deletedAt, seenAt) : (existing?.deletedAt ?? null),
    };
    this.branches.set(event.branchRef, merged);
  }

  /**
   * `keyed` keeps the first event for a key, but a session usually reads a task
   * before it closes one: `task list TP-1`, then `task done TP-1`. A status-
   * bearing mention therefore upgrades a bare one, never the other way round.
   */
  private foldTask(event: EventOf<"task">): void {
    const map = this.mapFor("tasks");
    const found = map.get(event.taskRef);
    const existing = found?.kind === "task" ? found : undefined;
    if (!existing || (event.status !== null && existing.status === null)) map.set(event.taskRef, event);
  }

  private keyed(name: string, key: string, event: SessionEvent): void {
    const map = this.mapFor(name);
    if (!map.has(key)) map.set(key, event);
  }

  private mapFor(name: string): Map<string, SessionEvent> {
    let map = this.byKey.get(name);
    if (!map) {
      map = new Map();
      this.byKey.set(name, map);
    }
    return map;
  }

  private append(name: string, event: SessionEvent): void {
    let list = this.lists.get(name);
    if (!list) {
      list = [];
      this.lists.set(name, list);
    }
    list.push(event);
  }
}

const LIST_OF: Record<
  "fact" | "span" | "phase" | "human_edit" | "file_checkpoint" | "pr_merge" | "pr_create" | "review_verdict" | AuditEventKind,
  string
> = {
  fact: "facts",
  span: "spans",
  phase: "phases",
  human_edit: "humanEdits",
  file_checkpoint: "fileCheckpoints",
  pr_merge: "prMerges",
  pr_create: "prCreates",
  review_verdict: "reviewVerdicts",
  request: "requests",
  tool_call: "toolCalls",
  inbound: "inbound",
  context_block: "contextBlocks",
  compaction: "compactions",
  queue_op: "queueOps",
  signal: "signals",
  cost_state: "costStates",
};

function isKind<K extends SessionEvent["kind"]>(kind: K): (event: SessionEvent) => event is EventOf<K> {
  return (event): event is EventOf<K> => event.kind === kind;
}

function earliest(a: string | null | undefined, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function latest(a: string | null | undefined, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Convenience over `EventFolder` for a finished event list. */
export function foldEvents(events: Iterable<SessionEvent>): TranscriptDelta {
  const folder = new EventFolder();
  for (const event of events) folder.fold(event);
  return folder.result();
}
