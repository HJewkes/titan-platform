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

export interface UsageRow {
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens: number;
  requestCount: number;
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
  usage: UsageRow[];
  turns: EventOf<"turn">[];
  facts: EventOf<"fact">[];
  spans: EventOf<"span">[];
  phases: EventOf<"phase">[];
  humanEdits: EventOf<"human_edit">[];
  fileCheckpoints: EventOf<"file_checkpoint">[];
  prs: EventOf<"pr">[];
  prMerges: EventOf<"pr_merge">[];
  prCreates: EventOf<"pr_create">[];
  branches: BranchRow[];
  files: EventOf<"file">[];
  tasks: EventOf<"task">[];
  subagents: EventOf<"subagent">[];
  subagentTranscripts: EventOf<"subagent_transcript">[];
  artifacts: EventOf<"artifact">[];
  edges: EventOf<"edge">[];
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
  private readonly usage = new Map<string, UsageRow>();
  private readonly branches = new Map<string, BranchRow>();
  private readonly byKey = new Map<string, Map<string, SessionEvent>>();
  private readonly lists = new Map<string, SessionEvent[]>();

  fold(event: SessionEvent): void {
    this.touchSession(event);
    switch (event.kind) {
      case "session":
        return this.foldSession(event);
      case "usage":
        return this.foldUsage(event);
      case "branch":
        return this.foldBranch(event);
      case "turn":
        return this.keyed("turns", event.promptId, event);
      case "pr":
        return this.keyed("prs", event.prRef, event);
      case "file":
        return this.keyed("files", event.fileRef, event);
      case "task":
        return this.keyed("tasks", event.taskRef, event);
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
    const list = <K extends keyof TranscriptDelta>(name: K): TranscriptDelta[K] =>
      ((this.lists.get(name) ?? []) as unknown[]) as TranscriptDelta[K];
    const keyed = <K extends keyof TranscriptDelta>(name: K): TranscriptDelta[K] =>
      ([...(this.byKey.get(name)?.values() ?? [])] as unknown[]) as TranscriptDelta[K];
    return {
      sessions: [...this.sessions.values()],
      usage: [...this.usage.values()],
      branches: [...this.branches.values()],
      turns: keyed("turns"),
      prs: keyed("prs"),
      files: keyed("files"),
      tasks: keyed("tasks"),
      subagents: keyed("subagents"),
      subagentTranscripts: keyed("subagentTranscripts"),
      artifacts: keyed("artifacts"),
      edges: keyed("edges"),
      facts: list("facts"),
      spans: list("spans"),
      phases: list("phases"),
      humanEdits: list("humanEdits"),
      fileCheckpoints: list("fileCheckpoints"),
      prMerges: list("prMerges"),
      prCreates: list("prCreates"),
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

  private foldUsage(event: EventOf<"usage">): void {
    const key = `${event.sessionId}\0${event.model}`;
    const row = this.usage.get(key) ?? { sessionId: event.sessionId, model: event.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, requestCount: 0 };
    row.inputTokens += event.inputTokens;
    row.outputTokens += event.outputTokens;
    row.cacheReadTokens += event.cacheReadTokens;
    row.cacheCreationTokens += event.cacheCreationTokens;
    row.thinkingTokens += event.thinkingTokens;
    row.requestCount += 1;
    this.usage.set(key, row);
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

  private keyed(name: string, key: string, event: SessionEvent): void {
    let map = this.byKey.get(name);
    if (!map) {
      map = new Map();
      this.byKey.set(name, map);
    }
    if (!map.has(key)) map.set(key, event);
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

const LIST_OF: Record<"fact" | "span" | "phase" | "human_edit" | "file_checkpoint" | "pr_merge" | "pr_create", string> = {
  fact: "facts",
  span: "spans",
  phase: "phases",
  human_edit: "humanEdits",
  file_checkpoint: "fileCheckpoints",
  pr_merge: "prMerges",
  pr_create: "prCreates",
};

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
