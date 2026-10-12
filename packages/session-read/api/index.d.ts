import { ConversationIdentity, UsageMeasurement, TokenCounts } from '@titan-design/agent-protocol';

/**
 * Tool name to cost-audit family, ported from the long-horizon research
 * extractor (`cf_extract.py:24-47`) so its published numbers stay comparable.
 */
type ToolFamily = "none" | "mcp_agentchat" | "mcp_other" | "fs_read" | "bash" | "fs_write" | "ask_user" | "subagent" | "web" | "scheduling" | "skill_toolsearch" | "other_tool";
interface ToolFamilyResult {
    readonly family: ToolFamily;
    /** The server segment of an `mcp__<server>__<tool>` name, else null. */
    readonly mcpServer: string | null;
}
declare function toolFamily(name: string | null | undefined): ToolFamilyResult;

type Json = Record<string, unknown>;
/**
 * Per-span cap on indexed text. A pasted build log or a 2 MB file read would
 * otherwise dominate the FTS index for no retrieval benefit; the locator still
 * points at the full record on disk.
 */
declare const SPAN_TEXT_CAP: number;
/** Bounded semantic text projection shared by normalized indexing and locator readback. */
declare function normalizedSearchText(value: unknown): string;
/**
 * The share of `output_tokens` attributable to extended thinking, estimated
 * from the character share of thinking blocks against all generated content on
 * the same line. Stateless per line, so incremental and full passes agree.
 */
declare function thinkingTokens(message: Json | null, outputTokens: number): number;
/** The prose of a line for one search field. The caller indexes it and discards it. */
declare function searchText(message: Json | null, field: SpanField): string;

/**
 * What woke the session, read off one arriving record. The transcript records
 * what arrived, not what a human did: a `<task-notification>` block is a
 * background task reporting in, not the human typing (wf_analyze.py:423-441).
 */

type WakeCause = "compaction" | "ask_user_answer" | "tool_result" | "channel_message" | "channel_system" | "task_notification" | "scheduled_wakeup" | "usage_limit_resume" | "harness_resume" | "local_command" | "image_meta" | "hook_or_reminder" | "human_typed";
type InboundDelivery = "turn_start" | "mid_loop" | "tool_result";
interface Inbound {
    readonly cause: WakeCause;
    readonly delivery: InboundDelivery;
    /** A short structural token (task id, command name, marker name), never message prose. */
    readonly detail: string | null;
    readonly originServer: string | null;
    readonly fromName: string | null;
    readonly msgId: string | null;
    /** The channel tag's own broadcast flag; null when the arrival carries no channel tag. */
    readonly broadcast: boolean | null;
    readonly toolUseId: string | null;
    readonly isError: boolean;
    readonly contentHash: string;
    readonly chars: number;
    /** The host's own label for who submitted the line: "typed", "system", or "sdk" for a headless `claude -p` or spawned turn. */
    readonly promptSource: string | null;
}
/** Rollup pairs a queued arrival with its delivery by this hash, so both sides must agree. */
declare const HASH_PREFIX_CHARS = 512;
declare function contentHash(text: string): string;
declare function classifyInbound(record: Json): Inbound;

/**
 * Bumped whenever a classification rule below changes, so a consumer can tell
 * rows extracted under an older rule set apart and re-index them.
 */
declare const EXTRACT_VERSION = 8;
/** Where the characters in one context block came from. */
type ContextSource = "tool_result" | "human" | "channel" | "assistant_text" | "assistant_thinking" | "assistant_tool_input" | "attachment" | "skill_listing" | "system_reminder" | "compaction_summary" | "image";
/** A recognisable act read from a single `tool_use` block. */
type SignalKind = "status_report" | "pr_create" | "commit" | "push" | "pr_merge" | "task_wrap" | "task_done" | "doc_written" | "agent_spawn" | "chat_send" | "command_heads" | "file_read" | "file_write";
/** Audit events locate themselves within a line, not just at it; 0 for whole-line events. */
interface AuditEventBase extends EventBase {
    blockIndex: number;
}
type AuditEvent = (AuditEventBase & {
    kind: "request";
    requestId: string;
    messageId: string | null;
    model: string;
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    cacheCreation5mTokens: number;
    cacheCreation1hTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    serviceTier: string | null;
    isSidechain: boolean;
}) | (AuditEventBase & {
    kind: "tool_call";
    toolUseId: string;
    name: string;
    family: ToolFamily;
    mcpServer: string | null;
    inputChars: number;
}) | (AuditEventBase & {
    kind: "inbound";
    cause: WakeCause;
    delivery: InboundDelivery;
    detail: string | null;
    originServer: string | null;
    fromName: string | null;
    msgId: string | null;
    broadcast: boolean | null;
    toolUseId: string | null;
    isError: boolean;
    contentHash: string;
    chars: number;
    promptSource: string | null;
}) | (AuditEventBase & {
    kind: "context_block";
    source: ContextSource;
    toolUseId: string | null;
    attachmentType: string | null;
    chars: number;
    isMedia: boolean;
}) | (AuditEventBase & {
    kind: "compaction";
    trigger: "manual" | "auto" | null;
    preTokens: number | null;
    postTokens: number | null;
    droppedTokens: number | null;
    durationMs: number | null;
}) | (AuditEventBase & {
    kind: "queue_op";
    operation: QueueOperation;
    contentHash: string | null;
    originServer: string | null;
}) | (AuditEventBase & {
    kind: "signal";
    signal: SignalKind;
    detail: string | null;
    toolUseId: string | null;
}) | (AuditEventBase & {
    kind: "cost_state";
    totalCostUsd: number;
    modelUsageJson: string;
});
type QueueOperation = "enqueue" | "dequeue" | "remove" | "popAll";
type AuditEventKind = AuditEvent["kind"];

/** Where in the transcript file the line that produced an event lives. */
interface LineSpan {
    byteOffset: number;
    byteLength: number;
}
/** Every event names its session, its timestamp, and the line it came from. */
interface EventBase extends LineSpan {
    sessionId: string;
    ts: string;
}
type SpanField = "prompt" | "assistant_response" | "tool_input" | "tool_result";
/** Descriptive fields observed on a line; how they merge across lines is `fold.ts`'s job. */
interface SessionPatch {
    entrypoint?: string;
    cwd?: string;
    cliVersion?: string;
    gitBranch?: string;
    aiTitle?: string;
    seedPrompt?: string;
}
type SessionEvent = (EventBase & {
    kind: "fact";
    eventType: string;
    promptId: string | null;
    toolUseId: string | null;
}) | (EventBase & {
    kind: "span";
    field: SpanField;
    text: string;
}) | (EventBase & {
    kind: "session";
    patch: SessionPatch;
    turnDelta: number;
    commitDelta: number;
    pushDelta: number;
}) | (EventBase & {
    kind: "turn";
    promptId: string;
}) | (EventBase & {
    kind: "phase";
    trigger: "mode" | "permission-mode";
    toMode: string;
}) | (EventBase & {
    kind: "human_edit";
    filePath: string;
}) | (EventBase & {
    kind: "file_checkpoint";
    filePath: string;
    backupFileName: string;
    version: number;
    backupTime: string;
}) | (EventBase & {
    kind: "pr";
    prRef: string;
    number: number;
    repo: string;
    title: string | null;
    url: string | null;
}) | (EventBase & {
    kind: "pr_merge";
    number: number;
    repoHint: string | null;
}) | (EventBase & {
    kind: "pr_create";
    toolUseId: string;
    title: string | null;
    number: number | null;
    repo: string | null;
    url: string | null;
}) | (EventBase & {
    kind: "review_verdict";
    toolUseId: string;
    /** The verdict's index among those parsed from this tool use's message. */
    ordinal: number;
    verdict: "approve" | "changes_requested";
    repo: string | null;
    repoHint: string | null;
    number: number;
    cwdRepo: string | null;
}) | (EventBase & {
    kind: "branch";
    branchRef: string;
    repo: string | null;
    name: string;
    base: string | null;
    deleted: boolean;
}) | (EventBase & {
    kind: "file";
    fileRef: string;
    repo: string | null;
    path: string;
}) | (EventBase & {
    kind: "task";
    taskRef: string;
    taskId: string;
    status: string | null;
}) | (EventBase & {
    kind: "subagent";
    agentRef: string;
    agentType: string | null;
    label: string | null;
}) | (EventBase & {
    kind: "subagent_transcript";
    agentRef: string;
    childSessionId: string;
}) | (EventBase & {
    kind: "artifact";
    artifactRef: string;
    artifactKind: string;
    title: string | null;
    url: string | null;
    path: string | null;
}) | (EventBase & {
    kind: "edge";
    sourceRef: string;
    relation: string;
    targetRef: string;
}) | AuditEvent;
type SessionEventKind = SessionEvent["kind"];
type EventOf<K extends SessionEventKind> = Extract<SessionEvent, {
    kind: K;
}>;

interface LineContext {
    line: Json;
    loc: LineSpan;
    sessionId: string;
    ts: string;
    cwd: string | null;
    gitBranch: string | null;
    repo: string | null;
}
type Emit = (event: SessionEvent) => void;
/**
 * Translates one transcript JSONL line into typed events. Every rule is
 * stateless across lines except the last-seen timestamp: a record such as
 * `cost-state` carries none of its own and takes the enclosing line's. A
 * caller resuming mid-file must pass `initialTs` (the last timestamp before
 * its start offset) so that fallback matches what a whole-file read would
 * have produced for the same line.
 *
 * `fallbackSessionId` is the transcript's own filename stem, for line types
 * that carry no `sessionId`. `subagentId` marks a subagent sidechain, where a
 * line's `sessionId` names the dispatching parent rather than this session.
 */
declare class LineReader {
    readonly emit: Emit;
    private readonly fallbackSessionId;
    private readonly subagentId;
    private lastTs;
    constructor(emit: Emit, fallbackSessionId?: string | null, subagentId?: string | null, initialTs?: string);
    handle(line: Json, loc: LineSpan): void;
    base(ctx: LineContext): EventBase;
    fact(ctx: LineContext, eventType: string, toolUseId?: string | null): void;
    span(ctx: LineContext, field: SpanField): void;
    session(ctx: LineContext, patch: SessionPatch, deltas?: {
        turn?: number;
        commit?: number;
        push?: number;
    }): void;
    edge(ctx: LineContext, sourceRef: string, relation: string, targetRef: string): void;
    recordBranch(ctx: LineContext, name: string, repo?: string | null, base?: string | null): void;
    /** A touched file, whether by a tool or by the human, becomes a file entity plus an edge. */
    recordFile(ctx: LineContext, rawPath: string, relation: string): {
        fileRef: string;
        path: string;
    } | null;
    recordArtifact(ctx: LineContext, id: string, artifactKind: string, fields: {
        title: string | null;
        url: string | null;
        path: string | null;
    }): void;
    private observeSession;
    /** Emitted per line on purpose: dedup happens downstream, and once-per-file would be cross-line state. */
    private spawnedBy;
    private dispatch;
    private system;
    private typedField;
    private prLink;
    private frameLink;
    private phase;
    /** `edited_text_file` is the only signal that a human, not Claude, changed a file mid-session. */
    private attachment;
    /** `trackedFileBackups` is full state that repeats on every snapshot; downstream dedup makes that a no-op. */
    private fileHistorySnapshot;
}

interface SessionRow {
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
interface BranchRow {
    branchRef: string;
    repo: string | null;
    name: string;
    base: string | null;
    createdAt: string | null;
    deletedAt: string | null;
}
/** One transcript chunk's events, merged so that applying N chunks equals one whole-file pass. */
interface TranscriptDelta {
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
/**
 * Merge rules are chosen so chunk boundaries cannot change the answer:
 * timestamps take min/max, counters sum, `gitBranch` and `seedPrompt` are
 * first-wins, `aiTitle`/`cwd`/`cliVersion` are last-wins, `startType` follows
 * the earliest line that carries an entrypoint, and ref-keyed rows dedupe.
 */
declare class EventFolder {
    private readonly sessions;
    private readonly startTypeAt;
    private readonly branches;
    private readonly byKey;
    private readonly lists;
    fold(event: SessionEvent): void;
    result(): TranscriptDelta;
    private session;
    private touchSession;
    private foldSession;
    /** Earliest line that carries an entrypoint wins; the session's first line often has none. */
    private foldStartType;
    /** Timestamps merge as min/max: a branch is seen from many chunks and many transcripts. */
    private foldBranch;
    /**
     * `keyed` keeps the first event for a key, but a session usually reads a task
     * before it closes one: `task list TP-1`, then `task done TP-1`. A status-
     * bearing mention therefore upgrades a bare one, never the other way round.
     */
    private foldTask;
    private keyed;
    private mapFor;
    private append;
}
/** Convenience over `EventFolder` for a finished event list. */
declare function foldEvents(events: Iterable<SessionEvent>): TranscriptDelta;

interface ReadOptions {
    /** Resume point; must be a line boundary. */
    fromByteOffset?: number;
    /** Stop after this offset, for tests simulating a partially grown file. */
    untilByteOffset?: number;
    /** Set for subagent sidechains, whose lines carry their parent's `sessionId`. */
    subagentId?: string | null;
    /** Session id for lines that carry none; defaults to the filename stem. */
    fallbackSessionId?: string | null;
}
/** A malformed JSON line aborts the transcript so the caller can quarantine it. */
declare class TranscriptParseError extends Error {
    readonly filePath: string;
    readonly byteOffset: number;
    constructor(filePath: string, byteOffset: number, cause: unknown);
}
interface ReadResult {
    /** Watermark to store: the byte after the last complete line consumed. */
    lastByteOffset: number;
    startByteOffset: number;
}
/**
 * Stream typed events from a transcript, starting at a watermark. The final
 * `lastByteOffset` is reported through `onDone` so a consumer that only
 * iterates events still learns where to resume.
 */
declare function readTranscriptEvents(filePath: string, options?: ReadOptions, onDone?: (result: ReadResult) => void): AsyncGenerator<SessionEvent>;
interface ExtractOptions extends ReadOptions {
    /** The stored prefix hash; a mismatch forces a full re-read from byte 0. */
    priorPrefixHash?: string | null;
}
interface ExtractResult extends TranscriptDelta, ReadResult {
    restartedFromZero: boolean;
    /** Hash of bytes `[0, lastByteOffset)`, to store beside the watermark. */
    prefixHash: string;
}
/** Read from the watermark (or byte 0 after a rewrite) and fold the events into one delta. */
declare function extractTranscript(filePath: string, options?: ExtractOptions): Promise<ExtractResult>;

/**
 * Relation vocabulary for the edges a transcript yields. Documented, not
 * enforced by a CHECK constraint: a new relation is an INSERT, never a migration.
 * Direction is fixed per name; reverse edges are never written.
 */
declare const RELATIONS: {
    /** session --touched--> file: any Read/Write/Edit/MultiEdit on that path. */
    readonly TOUCHED: "touched";
    /** session --linked--> pr: a `pr-link` event naming that PR. */
    readonly LINKED: "linked";
    /** session --worked--> branch: a git/gh command naming that branch. */
    readonly WORKED: "worked";
    /** session --ran--> task: an `active-work`/`aw` command naming that task id. */
    readonly RAN: "ran";
    /** session --spawned--> agent (the dispatch) or --spawned--> session (from the child's own sidechain). */
    readonly SPAWNED: "spawned";
    /** agent --transcribed_in--> session: the child transcript a dispatch produced. */
    readonly TRANSCRIBED_IN: "transcribed_in";
    /** session --produced--> artifact: an `Artifact` tool_use or `frame-link`. */
    readonly PRODUCED: "produced";
    /** session --edited_by_human--> file: an `edited_text_file` attachment. */
    readonly EDITED_BY_HUMAN: "edited_by_human";
};
type Relation = (typeof RELATIONS)[keyof typeof RELATIONS];
/** Refs derive from transcript content alone, never from a database id, so they are stable across rebuilds. */
declare const sessionRef: (sessionId: string) => string;
declare const fileRef: (repo: string | null, filePath: string) => string;
declare const prRef: (repo: string, prNumber: number) => string;
declare const branchRef: (repo: string | null, name: string) => string;
declare const taskRef: (taskId: string) => string;
declare const agentRef: (toolUseId: string) => string;
declare const artifactRef: (id: string) => string;
interface RepoRelativePath {
    repo: string | null;
    path: string;
}
/**
 * Resolve a touched file to `(repo, repo-relative path)` by its nearest `.git`
 * ancestor, so paths line up with `git ls-files` whatever directory the tool
 * call ran in. A file outside any working tree keeps its absolute form with a
 * null repo: unattributed, not mis-attributed. A path under a removed
 * `.worktrees/<name>/` resolves as if that worktree still existed.
 */
declare function toRepoRelative(filePath: string): RepoRelativePath;
/**
 * The inverse of `fileRef`: `file:<repo>/<path>` to `(repo, path)`, or null for
 * a ref that is not a file ref. A ref stored with a null repo (an absolute path,
 * or a bare relative one) comes back with a null repo, so callers render it as
 * plain text. A leaked `.worktrees/<name>/` prefix from an older ingest is
 * stripped, so the path is the code-graph file id.
 */
declare function parseFileRef(ref: string): RepoRelativePath | null;
/** The repo a tool call ran in, for signals keyed by `cwd` (branches, PRs). */
declare function repoForCwd(cwd: string | null): string | null;

/**
 * Verdict grammar (TP-409 S1). A verdict line either contains the word
 * `verdict` followed by a token, or begins (after optional markdown) with one
 * of the four line-start tokens. PR references are read from the verdict
 * line, or from the message's first line when the verdict line names none.
 * Every scan is a single bounded pass: no unbounded backtracking, so a
 * pathological single-line message still parses in linear time.
 */
type Verdict = "approve" | "changes_requested";
interface ReviewVerdictMatch {
    verdict: Verdict;
    repo: string | null;
    repoHint: string | null;
    number: number;
}
/** One entry per (repo-or-hint, number) pair named on a verdict line; a later line for the same pair replaces the earlier one. */
declare function parseReviewVerdicts(text: string): ReviewVerdictMatch[];

/**
 * The three-line reviewer block (TP-520): `Verdict: MERGE|FIX_FIRST`, `PR: owner/name#n`,
 * `Head: <40 lowercase hex>`. It gates merges, so text that may be someone else's only ever
 * makes it stricter. Rules, all per line and in one pass:
 * - A line is read only when indented 0 to 3 spaces (a tab counts 4, and any other character
 *   `trim` strips, such as U+00A0, counts 1); an indented-code line is never a block line.
 *   Trailing whitespace and CRLF are harmless.
 * - A quoted line ("> Verdict: MERGE") keeps its marker and never matches.
 * - A fence opens on ``` or ~~~ (3 or more), also after list or `>` markers, and closes only
 *   on a bare line of the same character at least as long. An unclosed fence hides the rest.
 * - An HTML comment hides every line that starts inside it, until a line holding `-->` with
 *   no `<!--` after its last `-->`.
 * - `Verdict: WAIT` (required checks unfinished at the head) is read as a block too, but never as `ok`: it
 *   returns `{ ok: false, reason: "wait" }` with the PR and head it names, so no MERGE path can take it.
 * - An optional fourth line `Closer: yes|no` (is this head closer to MERGE than the last reviewed one) is read
 *   only directly after Head and only on FIX_FIRST. Absent, on MERGE or WAIT, or any other value, a duplicate, or
 *   a line anywhere else, it leaves `closer` undefined and the block parses as it would without it.
 * - An optional fourth line `CI-policy: unchanged` or `CI-policy: weakened <key>(, <key>)*` (TP-2407) is read only
 *   directly after Head and only on MERGE. Keys come from a closed set, each at most once. An unknown or repeated key,
 *   an empty list, a duplicate line anywhere, or a line anywhere else leaves `ciPolicy` undefined, which the merge
 *   guard reads as missing: a `.github/` change then fails closed.
 * - Any visible line starting `Verdict:` is a block start, so a second one is refused, even
 *   when identical or malformed. A `Status:` line is ignored.
 */
type VerdictBlockVerdict = "MERGE" | "FIX_FIRST";
type VerdictBlockCloser = "yes" | "no";
declare const CI_POLICY_KEYS: readonly ["required-check", "permissions", "pull_request_target", "secrets", "ruleset", "other"];
type CiPolicyKey = (typeof CI_POLICY_KEYS)[number];
type CiPolicy = {
    kind: "unchanged";
} | {
    kind: "weakened";
    keys: CiPolicyKey[];
};
type VerdictBlockRefusal = "no_block" | "multiple_blocks" | "bad_verdict" | "missing_pr_line" | "bad_pr" | "missing_head_line" | "bad_head";
type VerdictBlockResult = {
    ok: true;
    verdict: VerdictBlockVerdict;
    repo: string;
    pr: number;
    head: string;
    lineOffset: number;
    closer?: VerdictBlockCloser;
    ciPolicy?: CiPolicy;
} | {
    ok: false;
    reason: "wait";
    repo: string;
    pr: number;
    head: string;
    lineOffset: number;
} | {
    ok: false;
    reason: VerdictBlockRefusal;
};
/** Reads the one Verdict/PR/Head block in `text`; `lineOffset` is the zero-based line of its Verdict line. */
declare function parseVerdictBlock(text: string): VerdictBlockResult;

/**
 * Authoritative repo attribution for a filesystem path (AW-91).
 *
 * The first cut derived a repo from `basename(cwd)`, which is a guess: any two
 * directories sharing a last path segment collapse into one repo. That is not
 * hypothetical — a checkout at `~/projects/active-work` and the CLI's own state
 * directory (whose path also ends in `active-work/active-work`) both
 * yielded `repo='active-work'`, so plain markdown state files were attributed
 * to the git repo and file precision in the ground-truth eval fell to 87%.
 *
 * The repo is now resolved by walking up to the nearest `.git` (the same thing
 * `git rev-parse --show-toplevel` reports) and naming it from the `origin`
 * remote, falling back to the toplevel's basename. A directory with no `.git`
 * ancestor — the state directory included — resolves to `null` and its files
 * stay unattributed rather than mis-attributed.
 *
 * Resolution is filesystem-derived rather than transcript-derived, so it is
 * memoized per directory: the extraction path calls this once per touched file
 * and a corpus pass touches the same handful of repos tens of thousands of
 * times. Nothing here shells out — `LineHandler` is synchronous and hot.
 */
interface RepoIdentity {
    /** Absolute path of the working-tree root (the `.git` holder). */
    root: string;
    /** Short repo name: `origin`'s repo segment, else `basename(root)`. */
    name: string;
}
/** Drop memoized lookups. Tests that build repos on the fly need this. */
declare function clearRepoCache(): void;
/**
 * Parse the `origin` remote's URL out of a git config file.
 *
 * Line-oriented rather than one regex: git config is an INI dialect where the
 * section header decides which `url =` is the one being read, and a regex that
 * has to both find the section and stop at the next one is harder to read than
 * the state machine it is emulating.
 */
declare function parseOriginUrl(config: string): string | null;
/** `git@github.com:org/active-work.git` / `https://…/org/active-work` -> `active-work`. */
declare function repoNameFromRemoteUrl(url: string): string | null;
/**
 * Nearest enclosing git working tree, or null when there is none.
 *
 * Every directory visited on the way up is memoized with the same answer, so a
 * deep path costs one walk for the whole subtree.
 */
declare function resolveRepo(startDir: string | null): RepoIdentity | null;

/** One shell word; a quoted word is data and never names a subcommand. */
interface ShellWord {
    readonly text: string;
    readonly quoted: boolean;
}
/** Splits a raw command into simple commands on `&&`, `||`, `;`, `|`, `&` and newlines, honouring quotes and heredocs. */
declare function splitCommands(raw: string): ShellWord[][];
/** The same simple commands, grouped into pipelines: the stages a `|` joins stay together, in order. */
declare function splitPipelines(raw: string): ShellWord[][][];

/** The `command_heads` signal: what each simple command in a Bash call runs, reduced to a low-cardinality head. */

/**
 * The program and up to two subcommand words of each simple command in `raw`
 * (`gh pr checks`, `git log`), plus `>basename` for every file it writes via a
 * redirect or `tee`. `cd` is dropped wherever it sits in the chain; duplicates
 * keep their first position.
 */
declare function commandHeads(raw: string): string[];
/** The head of one simple command, without the files it writes; null for `cd` or when it runs no program. */
declare function simpleCommandHead(words: readonly ShellWord[]): string | null;

/**
 * Deterministic intent extraction from raw (often compound) Bash commands —
 * ported behavior-preservingly from active-work's session miner
 * (AW-22 → AW-23).
 */

/** Build artifacts and vendored trees are never interesting file touches. */
declare const IGNORED_PATH: RegExp;
declare const TASK_ID: RegExp;
/** Strip leading `cd X && …` so we reach the real command verb. */
declare function realCommand(raw: string): string;
/**
 * The directory a compound command's git verb actually runs in.
 *
 * `cd ~/projects/x && git checkout -b feat/y` is the dominant shape in this
 * corpus, and the session's own `cwd` is frequently somewhere else entirely —
 * a state directory, a scratch dir. Attributing the branch to the session's
 * `cwd` therefore named the wrong repo, or none (AW-91). `git -C <dir>` wins
 * over a leading `cd` because it is the more specific of the two.
 */
declare function commandCwd(raw: string, sessionCwd: string | null): string | null;
interface GitIntent {
    setBranch: string | null;
    /** The branch `setBranch` was created from, when the command says so. */
    branchBase: string | null;
    deletedBranch: string | null;
    mergedPr: number | null;
    commit: boolean;
    push: boolean;
}
declare function parseGitIntent(raw: string): GitIntent | null;
/**
 * The `--title` of a `gh pr create`, which is the only place a PR title is
 * stated (AW-104).
 *
 * The title is read out of a shell command, so it still carries that command's
 * quoting: inside double quotes a backtick is written `\``, and storing it raw
 * puts a backslash in the title that GitHub never saw. Only the five characters
 * the shell actually treats as escapable in double quotes are unescaped, and
 * single-quoted titles are taken verbatim, because there `\` is a literal.
 */
declare function parsePrCreateTitle(raw: string): string | null;
/**
 * The task id an `active-work`/`aw` invocation acts on, if any. Unlike the
 * prototype this is NOT scoped to one initiative's slug: the production index
 * spans every initiative and repo-scoping is a query-time concern.
 */
declare function parseTaskId(command: string): string | null;
interface TaskIntent {
    taskId: string;
    /** The state the command puts the task in, when it says so outright. */
    status: string | null;
}
/**
 * Every task an `active-work`/`aw` invocation acts on. Two forms state a status
 * unambiguously, and across the same corpus they are the only ones worth
 * reading: `task done <slug> <ID>` (193 uses) and the explicit
 * `task edit <slug> <ID> status <value>` (1). `task add` mints the id inside the
 * tool, so it names no task; every other form is a read.
 *
 * A quoted mention inside `echo` now parses too. That trade is deliberate: a
 * stray reference is a task ref with no status, which is what a read produces
 * anyway, and losing three fifths of real closures is the worse error.
 */
declare function parseTaskIntents(command: string): TaskIntent[];
/** The first task the command names, or null. Kept for callers that want one. */
declare function parseTaskIntent(command: string): TaskIntent | null;

/** Expands a leading `~/` or a bare `~`; stored source keys can carry either. */
declare function expandHome(file: string, homeDir?: string): string;

interface DiscoveredTranscript {
    /** The project directory name Claude Code derives from the session's cwd. */
    projectDir: string;
    absolutePath: string;
    /** `~`-relative form; what gets stored in `transcripts.path`. */
    displayPath: string;
    /**
     * Set when this transcript is a built-in subagent sidechain, which lives at
     * `<project>/<parentSession>/subagents/agent-<agentId>.jsonl`.
     *
     * This is load-bearing, not decorative. Every line in such a file carries a
     * `sessionId` naming its *parent*, so indexing one as an ordinary transcript
     * files the subagent's turns, tokens and file touches under the parent and
     * silently inflates its metrics. The id here is what gives the subagent its
     * own identity instead; `isSidechain` cannot do the job, because 15 of the
     * 557 files in the corpus omit it on some lines. The path never lies.
     */
    subagentId: string | null;
    /** `"default"` for `~/.claude`, the profile directory name otherwise; `null` from `discoverTranscripts(root)` called directly. */
    account: string | null;
    /** The other machine a mirrored transcript was copied from; absent for this machine's own. */
    host?: string;
}
interface TranscriptRoot {
    root: string;
    account: string;
    /** Set only for a root under a `CLAUDE_TRANSCRIPT_MIRRORS` dir; such a root is a copy, not a config dir to run Claude Code with. */
    host?: string;
}
/**
 * `<host>=<dir>` entries, joined by the path delimiter. Each `<dir>/<account>/projects` is a
 * transcript root labelled with that host. A separate variable rather than an entry in
 * `CLAUDE_CONFIG_DIRS`, which also names the accounts whose credentials and usage get polled.
 */
declare const TRANSCRIPT_MIRRORS_ENV = "CLAUDE_TRANSCRIPT_MIRRORS";
/** Root of Claude Code's per-project transcript store for the default account. */
declare function transcriptsRoot(): string;
/**
 * Inverse of `toDisplayPath`, for the callers that hold a stored
 * `transcripts.path` and need to touch the file it names.
 */
declare function toAbsolutePath(displayPath: string): string;
/**
 * List every `~/.claude/projects/<project>/<session>.jsonl`, plus every
 * subagent sidechain nested at `<project>/<session>/subagents/agent-<id>.jsonl`,
 * sorted so a full corpus rebuild visits transcripts in a stable order. A
 * directory that disappears mid-walk is skipped rather than aborting the scan.
 */
declare function discoverTranscripts(root?: string): Promise<DiscoveredTranscript[]>;
/**
 * ~/.claude plus every ~/.claude-profiles/<name> that has a projects dir; CLAUDE_CONFIG_DIRS overrides.
 * Mirrored accounts from `CLAUDE_TRANSCRIPT_MIRRORS` follow either way.
 */
declare function claudeTranscriptRoots(env?: NodeJS.ProcessEnv): TranscriptRoot[];
/**
 * Discover transcripts across every root `claudeTranscriptRoots` finds,
 * stamping each with the account it came from.
 */
declare function discoverAllTranscripts(roots?: TranscriptRoot[]): Promise<DiscoveredTranscript[]>;

/**
 * One physical transcript source. A conversation may have more than one source.
 * Discovery must keep harness and namespace equal to the conversation identity;
 * decoders must reject inconsistent descriptors before emitting observations.
 */
interface SessionSourceDescriptor {
    /** Stable within the source namespace; paths may move between discovery passes. */
    sourceId: string;
    harness: string;
    format: string;
    formatVersion: string | null;
    path: string;
    namespace: string;
    conversation: ConversationIdentity;
    provenance: SessionSourceProvenance;
}
/** Provenance is explicit so compatibility aliases never depend on a namespace convention. */
type SessionSourceProvenance = {
    kind: "claude-code-transcript";
    legacySessionId: string;
} | {
    kind: "codex-rollout";
    sessionTreeId: string | null;
    historyMode: "legacy" | "paginated" | "unknown";
} | {
    kind: "native";
    name: string;
    details?: Readonly<Record<string, unknown>>;
};
/** The complete source line that carried one or more semantic subrecords. */
interface SourceLineEvidence {
    sourceId: string;
    byteOffset: number;
    byteLength: number;
    /** SHA-256 of the exact line bytes, excluding its newline. */
    contentHash: string;
    lineNumber: number | null;
    nativeOrdinal: number | null;
}
/** A decoder-stable location within a source line. */
interface SourceSubrecordEvidence {
    /** Distinguishes semantic siblings emitted from the same source line. */
    index: number;
    /** Format-native location, such as a JSON path. */
    path: readonly (string | number)[];
}
interface SourceEvidence {
    line: SourceLineEvidence;
    subrecord: SourceSubrecordEvidence;
}
/** Stable semantic identity without claiming that a native item ID is globally unique. */
interface ObservationIdentity {
    sourceId: string;
    byteOffset: number;
    subrecordIndex: number;
}
type ConversationItemKind = "turn" | "call" | "item" | "response";
/** A native identifier qualified by its conversation and category. */
interface ScopedConversationItemId<K extends ConversationItemKind = ConversationItemKind> {
    conversation: ConversationIdentity;
    kind: K;
    nativeId: string;
}
declare function scopedConversationItemRef(item: ScopedConversationItemId): string;
/** Selects decoded text within a record. There is deliberately no whole-line selector. */
interface SourceTextLocator {
    /** Discovery snapshot; resolve sourceId to the current path when sources move. */
    source: SessionSourceDescriptor;
    evidence: SourceEvidence;
    selector: {
        kind: "subrecord-text";
        path: readonly (string | number)[];
        textIndex?: number;
    };
}
interface NormalizedTextPart {
    kind: "text";
    text: string;
    locator: SourceTextLocator;
}
/** Native source fields retained without assigning portable semantics. */
interface NormalizedNativeExtension {
    name: string;
    value: unknown;
}
interface NormalizedObservationBase {
    nativeExtensions?: readonly NormalizedNativeExtension[];
    id: ObservationIdentity;
    /** Conversation represented by the physical source. */
    conversation: ConversationIdentity;
    /** Active native turn when the source format provides one. */
    turn?: ScopedConversationItemId<"turn"> | null;
    /** Set when copied history originated in a different conversation. */
    historyOrigin: ConversationIdentity | null;
    timestamp: string | null;
    evidence: SourceEvidence;
}
interface NormalizedMessageObservation extends NormalizedObservationBase {
    kind: "message";
    role: "user" | "assistant";
    item: ScopedConversationItemId<"item"> | null;
    representation: "canonical" | "projection-fallback";
    content: readonly NormalizedTextPart[];
}
interface NormalizedToolCallObservation extends NormalizedObservationBase {
    kind: "tool_call";
    call: ScopedConversationItemId<"call">;
    item: ScopedConversationItemId<"item"> | null;
    name: string;
    namespace: string | null;
    input: unknown;
    inputLocator: SourceTextLocator | null;
}
interface NormalizedToolResultObservation extends NormalizedObservationBase {
    kind: "tool_result";
    call: ScopedConversationItemId<"call">;
    item: ScopedConversationItemId<"item"> | null;
    output: unknown;
    outputLocator: SourceTextLocator | null;
    isError: boolean | null;
}
interface NormalizedNativeTurnObservation extends NormalizedObservationBase {
    kind: "native_turn";
    turn: ScopedConversationItemId<"turn">;
    rootTurn: ScopedConversationItemId<"turn"> | null;
    phase: "started" | "completed" | "aborted" | "observed";
}
/** Native-valued entries preserve metadata that does not yet have shared semantics. */
interface NormalizedMetadataObservation extends NormalizedObservationBase {
    kind: "metadata";
    scope: "source" | "conversation" | "turn";
    turn: ScopedConversationItemId<"turn"> | null;
    entries: readonly {
        name: string;
        value: unknown;
        meaning: "normalized" | "native";
    }[];
}
type DeltaUsage = Extract<UsageMeasurement, {
    kind: "delta";
}>;
type SnapshotUsage = Extract<UsageMeasurement, {
    kind: "snapshot";
}>;
/** Cache writes by time to live; the two rates differ, so a price needs the split, not the total. */
interface CacheWriteSplit {
    ttl5m: number;
    ttl1h: number;
}
type NormalizedUsageObservation = NormalizedObservationBase & ({
    kind: "usage";
    measurement: DeltaUsage;
    response: ScopedConversationItemId<"response">;
    turn: ScopedConversationItemId<"turn"> | null;
    /** Absent when the source reports only the cache-write total. */
    cacheWriteSplit?: CacheWriteSplit;
} | {
    kind: "usage";
    measurement: SnapshotUsage;
    response: null;
    turn: ScopedConversationItemId<"turn"> | null;
});
interface NormalizedCompactionObservation extends NormalizedObservationBase {
    kind: "compaction";
    turn: ScopedConversationItemId<"turn"> | null;
    item: ScopedConversationItemId<"item"> | null;
    encrypted: boolean | null;
    usageEpochAfter: string | null;
}
interface NormalizedLineageObservation extends NormalizedObservationBase {
    kind: "lineage";
    relationship: "parent" | "forked_from";
    relatedConversation: ConversationIdentity;
    copiedThroughTurn: ScopedConversationItemId<"turn"> | null;
}
interface NormalizedUnknownObservation extends NormalizedObservationBase {
    kind: "unknown";
    nativeKind: string;
    value: unknown;
}
type NormalizedSessionObservation = NormalizedMessageObservation | NormalizedToolCallObservation | NormalizedToolResultObservation | NormalizedNativeTurnObservation | NormalizedMetadataObservation | NormalizedUsageObservation | NormalizedCompactionObservation | NormalizedLineageObservation | NormalizedUnknownObservation;
type NormalizedObservationKind = NormalizedSessionObservation["kind"];
type NormalizedObservationOf<K extends NormalizedObservationKind> = Extract<NormalizedSessionObservation, {
    kind: K;
}>;
/** A complete newline-terminated record. Partial final lines are retried by the caller. */
interface LocatedSourceLine {
    raw: string;
    evidence: SourceLineEvidence;
}
/** Boundary immediately after a complete line, bound to the exact preceding bytes. */
interface ResumeBoundary {
    byteOffset: number;
    prefixHash: string;
}
interface DecoderCheckpoint<State> {
    decoderId: string;
    checkpointVersion: string;
    sourceId: string;
    boundary: ResumeBoundary;
    state: State;
}
/**
 * Lines begin at `readFromByteOffset`; observations before `emitFrom` are suppressed.
 * A decoder may therefore replay a prefix for state, or continue from a validated
 * checkpoint. Callers fall back to replay when any checkpoint identity or hash differs.
 */
type DecodeResume<State> = {
    strategy: "replay-prefix";
    readFromByteOffset: 0;
    emitFrom: ResumeBoundary;
    checkpoint: null;
} | {
    strategy: "checkpoint";
    readFromByteOffset: number;
    emitFrom: ResumeBoundary;
    checkpoint: DecoderCheckpoint<State>;
};
interface DecodeRequest<State> {
    source: SessionSourceDescriptor;
    lines: AsyncIterable<LocatedSourceLine>;
    resume: DecodeResume<State>;
}
interface DecodeResult<State> {
    resumeBoundary: ResumeBoundary;
    checkpoint: DecoderCheckpoint<State> | null;
}
type EmitNormalizedObservation = (observation: NormalizedSessionObservation) => void;
/** Format adapter contract; implementations arrive with their respective decoders. */
interface SessionFormatDecoder<State = unknown> {
    readonly decoderId: string;
    readonly checkpointVersion: string;
    decode(request: DecodeRequest<State>, emit: EmitNormalizedObservation): Promise<DecodeResult<State>>;
    /**
     * Returns only selected semantic text, never the complete JSON record. Resolve
     * moved sources by sourceId; return null if unavailable rather than reading an
     * unrelated file now occupying the snapshot path.
     */
    readText(locator: SourceTextLocator): Promise<string | null>;
}
/** Explicit compatibility bridge for sources proven to use Claude's legacy session IDs. */
declare function legacyClaudeSessionRef(source: SessionSourceDescriptor): string | null;

declare const CODEX_ROLLOUT_FORMAT = "codex-rollout-jsonl";
interface DiscoverCodexSourcesOptions {
    codexHome?: string;
    namespace: string;
}
declare class CodexSourceCollisionError extends Error {
    readonly sources: readonly SessionSourceDescriptor[];
    constructor(sources: readonly SessionSourceDescriptor[]);
}
/** The Codex CLI's home: CODEX_HOME when set, as the CLI itself resolves it, else ~/.codex. */
declare function codexHome(env?: NodeJS.ProcessEnv): string;
/** Discover persisted active and archived rollouts without requiring private state databases. */
declare function discoverCodexSources(options: DiscoverCodexSourcesOptions): Promise<SessionSourceDescriptor[]>;
declare function codexSourceId(namespace: string, nativeId: string, rolloutName: string): string;

declare const CODEX_DECODER_ID = "codex-rollout";
declare const CODEX_CHECKPOINT_VERSION = "1";
/** Prefix-replay decoder. Checkpoint state is reserved by the shared contract. */
declare class CodexRolloutDecoder implements SessionFormatDecoder<never> {
    readonly decoderId = "codex-rollout";
    readonly checkpointVersion = "1";
    decode(request: DecodeRequest<never>, emit: EmitNormalizedObservation): Promise<DecodeResult<never>>;
    readText(locator: SourceTextLocator): Promise<string | null>;
}

interface ReadCodexOptions {
    from?: ResumeBoundary;
    /** Test seam for ending after a complete line in a growing rollout. */
    untilByteOffset?: number;
}
interface CodexReadResult {
    startByteOffset: number;
    resumeBoundary: ResumeBoundary;
    restartedFromZero: boolean;
}
interface ReadCodexTextOptions {
    /** Fresh discovery results let a moved active/archive source resolve by sourceId. */
    sources?: readonly SessionSourceDescriptor[];
}
/** Prefix-replay reader with byte-hash rewrite detection and streaming observation delivery. */
declare function readCodexObservations(source: SessionSourceDescriptor, options?: ReadCodexOptions, onDone?: (result: CodexReadResult) => void): AsyncGenerator<NormalizedSessionObservation>;
/** Read only the selected semantic subrecord, never the containing JSON line. */
declare function readCodexText(locator: SourceTextLocator, options?: ReadCodexTextOptions): Promise<string | null>;

interface SessionTextRequest {
    path: string;
    byteOffset: number;
    byteLength: number;
    field: SpanField;
}
/** Legacy Claude read-back through the same field projection used at ingest time. */
declare function readSessionText(request: SessionTextRequest): Promise<string | null>;

interface SessionUsageSummary {
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    requestCount: number | null;
    tokens: TokenCounts;
    basis: "delta" | "snapshot";
}
/** Collects one conversation's measurements; the shared fold decides which count. Memory grows with every measurement added, so callers fold once after their loop. */
declare class SessionUsageAccumulator {
    private readonly measurements;
    add(measurement: UsageMeasurement): void;
    summaries(): SessionUsageSummary[];
}

interface SessionToolSummary {
    callRef: string;
    name: string | null;
    calledAt: string | null;
    resultAt: string | null;
    /** Observed call-to-result span, not harness execution time. */
    durationMs: number | null;
    isError: boolean | null;
    /** Only explicit native toolDenialKind evidence; absence is not permission success. */
    permissionDenialKind: string | null;
    hasCall: boolean;
    hasResult: boolean;
}
interface SessionSummary {
    conversation: ConversationIdentity;
    observationCount: number;
    /** Copied history is excluded from this conversation's metrics when native evidence identifies it. */
    copiedObservationCount: number;
    messages: {
        user: number;
        assistant: number;
    };
    nativeTurnCount: number | null;
    observationSpan: {
        firstAt: string | null;
        lastAt: string | null;
        durationMs: number | null;
    };
    observedModel: string | null;
    cwd: string | null;
    gitBranch: string | null;
    cliVersion: string | null;
    tools: SessionToolSummary[];
    toolErrors: {
        observed: number;
        unknownResults: number;
    };
    explicitlyEvidencedPermissionDenials: number;
    compactions: number;
    usage: SessionUsageSummary[];
    usageAvailability: "observed" | "unreported";
    /** Native-valued fields retain their provider names for downstream compatibility. */
    nativeMetadata: Record<string, unknown>;
    unknownKinds: string[];
}
/** A storage-free fold; no transcript observation establishes process liveness. */
declare class SessionSummaryAccumulator {
    private readonly usage;
    private readonly tools;
    private readonly turns;
    private readonly messages;
    private readonly unknownKinds;
    private readonly summary;
    constructor(conversation: ConversationIdentity);
    add(observation: NormalizedSessionObservation): void;
    result(): SessionSummary;
    private observeTimestamp;
    private observeMessage;
    private observeTool;
    private observeMetadata;
}
declare function summarizeSession(source: SessionSourceDescriptor): Promise<SessionSummary>;

/**
 * Facts-only recovery of a session that ended with no wrap (reboot, crash, closed window).
 * Everything here is read from the transcript: no model call, no network, no write.
 */

declare const RECOVERY_MESSAGE_CHARS = 2000;
declare const RECOVERY_FIRST_LINE_CHARS = 200;
declare const RECOVERY_OWNER_MESSAGES = 5;
declare const RECOVERY_LIST_CAP = 50;
/** How far back the owner and assistant messages are looked for; earlier ones are outside the window. */
declare const RECOVERY_TAIL_BYTES: number;
interface CappedList<T> {
    items: T[];
    /** Entries left out because the list reached its cap. */
    dropped: number;
}
interface RecoveredCommand {
    /** A `commandHeads` head (`git push`, `active-work task done`); argument text never appears. */
    head: string;
    count: number;
    lastAt: string | null;
}
interface RecoveredMessageTarget {
    /** The recipient of a chat_send, or the name given to agent_spawn; null when the call named none. */
    target: string | null;
    firstLine: string;
    at: string | null;
}
interface RecoveredMessage {
    text: string;
    at: string | null;
}
interface SessionRecovery {
    conversation: ConversationIdentity;
    startedAt: string | null;
    endedAt: string | null;
    /** The name of the session's last chat_register call. */
    agentName: string | null;
    /** Paths relative to `root`, in first-write order; the cap keeps the first ones. */
    filesWritten: CappedList<string>;
    activeWorkCalls: CappedList<RecoveredCommand>;
    gitCommands: CappedList<RecoveredCommand>;
    /** In call order; the cap keeps the most recent. */
    chatSends: CappedList<RecoveredMessageTarget>;
    agentSpawns: CappedList<RecoveredMessageTarget>;
    /** The last owner-typed messages, oldest first; tool results and injected blocks are excluded. */
    ownerMessages: RecoveredMessage[];
    lastAssistantMessage: RecoveredMessage | null;
    /** The message window began after the transcript's start, so older owner messages were not read. */
    messageWindowTruncated: boolean;
}
interface RecoverSessionOptions {
    /** Only files written under this absolute path are reported. */
    root: string;
}
declare function recoverSession(source: SessionSourceDescriptor, options: RecoverSessionOptions): Promise<SessionRecovery>;
/** A storage-free fold of the tool calls a recovery record reports. */
declare class RecoveryFacts {
    private readonly root;
    private agentName;
    private readonly files;
    private readonly activeWork;
    private readonly git;
    private readonly chatSends;
    private readonly agentSpawns;
    constructor(root: string);
    add(observation: NormalizedSessionObservation): void;
    result(): Pick<SessionRecovery, "agentName" | "filesWritten" | "activeWorkCalls" | "gitCommands" | "chatSends" | "agentSpawns">;
    private addFile;
    private addCommand;
    private addChat;
}

declare const CLAUDE_TRANSCRIPT_FORMAT = "claude-code-jsonl";
interface FindClaudeSessionSourceInput {
    cwd: string;
    conversation: ConversationIdentity;
    /** Claude configuration root. Defaults to CLAUDE_CONFIG_DIR or ~/.claude. */
    configDir?: string;
}
type SessionSourceLookup = {
    status: "found";
    source: SessionSourceDescriptor;
} | {
    status: "not_written";
    expectedPath: string;
} | {
    status: "unavailable";
    reason: string;
};
/** Claude's lossy cwd-to-project-directory mapping. */
declare function claudeProjectSlug(cwd: string): string;
declare function claudeSourceId(namespace: string, nativeId: string): string;
/** Locate one ordinary Claude transcript by exact native session ID. */
declare function findClaudeSessionSource(input: FindClaudeSessionSourceInput): SessionSourceLookup;
/** Describe a transcript whose path is already known; the native ID comes from its filename. */
declare function claudeSourceFromPath(filePath: string, namespace: string): SessionSourceDescriptor;
/** Reject descriptors whose path or provenance could name another conversation. */
declare function assertClaudeSessionSource(source: SessionSourceDescriptor): void;

declare const CLAUDE_DECODER_ID = "claude-code-transcript";
declare const CLAUDE_CHECKPOINT_VERSION = "1";
/** Authoritative Claude transcript decoder. State is recovered by replaying the verified prefix. */
declare class ClaudeTranscriptDecoder implements SessionFormatDecoder<never> {
    readonly decoderId = "claude-code-transcript";
    readonly checkpointVersion = "1";
    decode(request: DecodeRequest<never>, emit: EmitNormalizedObservation): Promise<DecodeResult<never>>;
    readText(locator: SourceTextLocator): Promise<string | null>;
}

interface ClaudeToolLineBase {
    callId: string;
    timestamp: string | null;
    sessionId: string | null;
    /** 0-based position in the input, counting blank and malformed lines. */
    lineIndex: number;
}
interface ClaudeToolCallLine extends ClaudeToolLineBase {
    kind: "tool_call";
    name: string;
    input: unknown;
}
interface ClaudeToolResultLine extends ClaudeToolLineBase {
    kind: "tool_result";
    output: unknown;
    isError: boolean | null;
}
type ClaudeToolLine = ClaudeToolCallLine | ClaudeToolResultLine;
/**
 * Sync, descriptor-free decode of tool calls and results from raw Claude JSONL lines.
 * Skips blank, malformed and non-object lines, never checks session identity, and
 * yields a repeated call id every time it appears: joining and dedup are the caller's.
 */
declare function decodeClaudeToolLines(lines: Iterable<string>): Generator<ClaudeToolLine>;

interface ReadSessionObservationOptions {
    from?: ResumeBoundary;
    /** Test seam for ending after a complete line in a growing source. */
    untilByteOffset?: number;
}
interface SessionObservationReadResult {
    startByteOffset: number;
    resumeBoundary: ResumeBoundary;
    restartedFromZero: boolean;
}
interface ReadSessionSourceTextOptions {
    /** Fresh discovery results used to resolve a source whose path moved. */
    sources?: readonly SessionSourceDescriptor[];
}
/** Dispatch authoritative normalized observation reads by explicit source format and harness. */
declare function readSessionObservations(source: SessionSourceDescriptor, options?: ReadSessionObservationOptions, onDone?: (result: SessionObservationReadResult) => void): AsyncGenerator<NormalizedSessionObservation>;
/** Read selected semantic text through the format named by a locator snapshot. */
declare function readSessionSourceText(locator: SourceTextLocator, options?: ReadSessionSourceTextOptions): Promise<string | null>;

interface ReadClaudeTextOptions {
    /** Fresh lookup results let callers resolve a moved source by stable source ID. */
    sources?: readonly SessionSourceDescriptor[];
}
/** Prefix-replay reader with bounded observation buffering and rewrite detection. */
declare function readClaudeObservations(source: SessionSourceDescriptor, options?: ReadSessionObservationOptions, onDone?: (result: SessionObservationReadResult) => void): AsyncGenerator<NormalizedSessionObservation>;
/** Read one selected semantic field from a Claude transcript locator. */
declare function readClaudeText(locator: SourceTextLocator, options?: ReadClaudeTextOptions): Promise<string | null>;

type RecentTurnRole = "user" | "assistant" | "system";
type RecentTurnKind = "message" | "tool_call" | "tool_result";
type RecentTurnRepresentation = "native" | "canonical" | "projection-fallback";
/** `activity` renders tool calls, results and thinking markers; `text` keeps only what user and assistant said. */
type RecentTurnProjection = "activity" | "text";
interface RecentSessionTurn {
    role: RecentTurnRole;
    kind: RecentTurnKind;
    timestamp: string | null;
    text: string;
    representation: RecentTurnRepresentation;
    sidechain: boolean | null;
    /** Null means the source did not report error state, or this is not a result. */
    toolResultError: boolean | null;
    evidence: SourceLineEvidence;
}
type RecentObservedValue<T> = {
    status: "observed";
    value: T;
    evidence: SourceLineEvidence;
} | {
    status: "unknown";
    reason: RecentUnknownReason;
};
type RecentUnknownReason = "outside_window" | "not_reported" | "source_unavailable" | "malformed_records" | "unsupported_by_format";
interface RecentSessionUnknown {
    field: "model" | "branch" | "sidechain" | "tool_result_error";
    reason: RecentUnknownReason;
    evidence?: SourceLineEvidence;
}
interface RecentSessionReadError {
    kind: "io" | "invalid_utf8" | "malformed_record";
    reason: string;
    evidence?: SourceLineEvidence;
}
interface RecentSessionTurns {
    status: "read" | "unavailable";
    source: SessionSourceDescriptor;
    turns: readonly RecentSessionTurn[];
    model: RecentObservedValue<string>;
    branch: RecentObservedValue<string>;
    bytesRead: number;
    /** The byte window omitted an earlier part of the source. */
    truncatedBefore: boolean;
    /** The source ended with an incomplete record or grew during the read. */
    truncatedAfter: boolean;
    /** Complete parsed turns were omitted only because maxTurns was reached. */
    truncatedTurns: boolean;
    errors: readonly RecentSessionReadError[];
    unknown: readonly RecentSessionUnknown[];
}
interface ReadRecentSessionTurnsOptions {
    maxBytes: number;
    maxTurns: number;
    maxCharsPerTurn: number;
    /** Applied before maxTurns, so `text` returns the last maxTurns spoken turns. Defaults to `activity`. */
    projection?: RecentTurnProjection;
}

declare function readRecentSessionTurns(source: SessionSourceDescriptor, options: ReadRecentSessionTurnsOptions): Promise<RecentSessionTurns>;
declare function readRecentSessionTurnsSync(source: SessionSourceDescriptor, options: ReadRecentSessionTurnsOptions): RecentSessionTurns;

type SessionIdentityErrorCode = "foreign_native_session" | "multiple_parent_sessions";
/** Extends TypeError so existing `instanceof TypeError` catches keep working for a released consumer. */
declare class SessionIdentityError extends TypeError {
    readonly code: SessionIdentityErrorCode;
    constructor(message: string, code: SessionIdentityErrorCode);
}

/**
 * The blocks the harness injects into a `user` record. Two consumers share this
 * list: the wake-cause rules label an arriving record by it, and TP-108 strips
 * the same blocks out of indexed user text.
 */
type InjectedMarkerName = "channel" | "task_notification" | "system_reminder" | "local_command" | "compaction_summary" | "image_meta" | "loop_wakeup" | "spawn_brief";
interface InjectedMarker {
    readonly name: InjectedMarkerName;
    /** Matched against the head of the record text. */
    readonly open: RegExp;
    /** Closing tag, when the marker opens a block that can be cut out whole. */
    readonly close: string | null;
    /** True when the marker only counts at the very start of the text. */
    readonly anchored: boolean;
}
/** cf_extract.py scans this far into a record for an injected tag; keep its window. */
declare const MARKER_SCAN_CHARS = 400;
declare const INJECTED_MARKERS: Readonly<Record<InjectedMarkerName, InjectedMarker>>;
declare function hasMarker(text: string, name: InjectedMarkerName): boolean;
/** The first marker present in the head of `text`, in declaration order. */
declare function findInjectedMarker(text: string): InjectedMarkerName | null;
interface ChannelTag {
    readonly source: string;
    readonly from: string | null;
    readonly msgId: string | null;
    readonly isSystem: boolean;
    /** agent-chat writes `broadcast="true"` on a broadcast and omits it on a DM. */
    readonly broadcast: boolean;
}
declare function parseChannelTag(text: string): ChannelTag | null;

/** Below this, an attachment is a fixed harness note (`output_style`, `total_tokens_reminder`) repeated every turn. */
declare const MIN_ATTACHMENT_CHARS = 256;
/** The text of a user record is labelled by what delivered it, since the harness injects most of it. */
declare function sourceForCause(cause: WakeCause | null): ContextSource;

/** Provisional vocabulary: every signal is read from one `tool_use` block, never across lines. */
interface AuditSignal {
    readonly signal: SignalKind;
    /** A short structural token (status word, PR number, task id, path), never prose. */
    readonly detail: string | null;
}
/** Signals any tool call can carry; Bash command verbs are read separately by `bashSignals`. */
declare function toolUseSignals(name: string, input: Json | null): AuditSignal[];
/** `git` is the caller's already-parsed intent, so commit and push agree with the session counters. */
declare function bashSignals(command: string, git: GitIntent | null): AuditSignal[];

/**
 * Which task a spawned session was assigned, read from its agent name and spawn brief (TP-407).
 * The rules are the normative "Linking rules" of the TP-407 plan; TP-108 shares `orientationEnd`.
 */
/** agent-chat opens an injected orientation block with this line. */
declare const ORIENTATION_HEADER = "# Orientation: active-work initiative \"";
/** `none` is a definite "no id links", distinct from a session no task-aware resolver has seen. */
type AssignmentSource = "name" | "name-over-brief" | "brief-anchor" | "brief-paragraph" | "none";
interface AssignmentInput {
    readonly agentName: string;
    readonly brief: string;
    /** True when the id is a task file in the active-work store, archived or not. */
    readonly isKnown: (taskId: string) => boolean;
    /** Length of the injected orientation block, from agent-chat's `agent_spawned` meta `briefing_chars`. */
    readonly briefingChars?: number;
}
interface Assignment {
    readonly taskIds: readonly string[];
    readonly source: AssignmentSource;
}
/**
 * Where the assignment starts in a spawn brief: 0 when the brief has no orientation block,
 * null when it has one whose end cannot be found (such a brief yields no ids).
 * A recorded `briefingChars` wins over the heading rules, which break when agent-chat renames a heading.
 */
declare function orientationEnd(brief: string, briefingChars?: number): number | null;
/** The task ids a spawned session was assigned, and which rule found them. */
declare function assignedTaskIds(input: AssignmentInput): Assignment;

export { type Assignment, type AssignmentInput, type AssignmentSource, type AuditEvent, type AuditEventBase, type AuditEventKind, type AuditSignal, type BranchRow, CI_POLICY_KEYS, CLAUDE_CHECKPOINT_VERSION, CLAUDE_DECODER_ID, CLAUDE_TRANSCRIPT_FORMAT, CODEX_CHECKPOINT_VERSION, CODEX_DECODER_ID, CODEX_ROLLOUT_FORMAT, type CacheWriteSplit, type CappedList, type ChannelTag, type CiPolicy, type CiPolicyKey, type ClaudeToolCallLine, type ClaudeToolLine, type ClaudeToolResultLine, ClaudeTranscriptDecoder, type CodexReadResult, CodexRolloutDecoder, CodexSourceCollisionError, type ContextSource, type ConversationItemKind, type DecodeRequest, type DecodeResult, type DecodeResume, type DecoderCheckpoint, type DiscoverCodexSourcesOptions, type DiscoveredTranscript, EXTRACT_VERSION, type Emit, type EmitNormalizedObservation, type EventBase, EventFolder, type EventOf, type ExtractOptions, type ExtractResult, type FindClaudeSessionSourceInput, type GitIntent, HASH_PREFIX_CHARS, IGNORED_PATH, INJECTED_MARKERS, type Inbound, type InboundDelivery, type InjectedMarker, type InjectedMarkerName, type LineContext, LineReader, type LineSpan, type LocatedSourceLine, MARKER_SCAN_CHARS, MIN_ATTACHMENT_CHARS, type NormalizedCompactionObservation, type NormalizedLineageObservation, type NormalizedMessageObservation, type NormalizedMetadataObservation, type NormalizedNativeExtension, type NormalizedNativeTurnObservation, type NormalizedObservationBase, type NormalizedObservationKind, type NormalizedObservationOf, type NormalizedSessionObservation, type NormalizedTextPart, type NormalizedToolCallObservation, type NormalizedToolResultObservation, type NormalizedUnknownObservation, type NormalizedUsageObservation, ORIENTATION_HEADER, type ObservationIdentity, type QueueOperation, RECOVERY_FIRST_LINE_CHARS, RECOVERY_LIST_CAP, RECOVERY_MESSAGE_CHARS, RECOVERY_OWNER_MESSAGES, RECOVERY_TAIL_BYTES, RELATIONS, type ReadClaudeTextOptions, type ReadCodexOptions, type ReadCodexTextOptions, type ReadOptions, type ReadRecentSessionTurnsOptions, type ReadResult, type ReadSessionObservationOptions, type ReadSessionSourceTextOptions, type RecentObservedValue, type RecentSessionReadError, type RecentSessionTurn, type RecentSessionTurns, type RecentSessionUnknown, type RecentTurnKind, type RecentTurnProjection, type RecentTurnRepresentation, type RecentTurnRole, type RecentUnknownReason, type RecoverSessionOptions, type RecoveredCommand, type RecoveredMessage, type RecoveredMessageTarget, RecoveryFacts, type Relation, type RepoIdentity, type RepoRelativePath, type ResumeBoundary, type ReviewVerdictMatch, SPAN_TEXT_CAP, type ScopedConversationItemId, type SessionEvent, type SessionEventKind, type SessionFormatDecoder, SessionIdentityError, type SessionIdentityErrorCode, type SessionObservationReadResult, type SessionPatch, type SessionRecovery, type SessionRow, type SessionSourceDescriptor, type SessionSourceLookup, type SessionSourceProvenance, type SessionSummary, SessionSummaryAccumulator, type SessionTextRequest, type SessionToolSummary, SessionUsageAccumulator, type SessionUsageSummary, type ShellWord, type SignalKind, type SourceEvidence, type SourceLineEvidence, type SourceSubrecordEvidence, type SourceTextLocator, type SpanField, TASK_ID, TRANSCRIPT_MIRRORS_ENV, type TaskIntent, type ToolFamily, type ToolFamilyResult, type TranscriptDelta, TranscriptParseError, type TranscriptRoot, type Verdict, type VerdictBlockRefusal, type VerdictBlockResult, type VerdictBlockVerdict, type WakeCause, agentRef, artifactRef, assertClaudeSessionSource, assignedTaskIds, bashSignals, branchRef, classifyInbound, claudeProjectSlug, claudeSourceFromPath, claudeSourceId, claudeTranscriptRoots, clearRepoCache, codexHome, codexSourceId, commandCwd, commandHeads, contentHash, decodeClaudeToolLines, discoverAllTranscripts, discoverCodexSources, discoverTranscripts, expandHome, extractTranscript, fileRef, findClaudeSessionSource, findInjectedMarker, foldEvents, hasMarker, legacyClaudeSessionRef, normalizedSearchText, orientationEnd, parseChannelTag, parseFileRef, parseGitIntent, parseOriginUrl, parsePrCreateTitle, parseReviewVerdicts, parseTaskId, parseTaskIntent, parseTaskIntents, parseVerdictBlock, prRef, readClaudeObservations, readClaudeText, readCodexObservations, readCodexText, readRecentSessionTurns, readRecentSessionTurnsSync, readSessionObservations, readSessionSourceText, readSessionText, readTranscriptEvents, realCommand, recoverSession, repoForCwd, repoNameFromRemoteUrl, resolveRepo, scopedConversationItemRef, searchText, sessionRef, simpleCommandHead, sourceForCause, splitCommands, splitPipelines, summarizeSession, taskRef, thinkingTokens, toAbsolutePath, toRepoRelative, toolFamily, toolUseSignals, transcriptsRoot };
