/**
 * The one place the daemon shells out to another program — shared by P3's
 * `initiative.ts` today and step 6d's `spawn.ts` later, so the discipline
 * sources/agent-runner-plan.md's P3 section demands is stated once, not
 * duplicated: absolute binary paths only (never resolved via `PATH`, which
 * launchd does not populate the way a login shell does), and an explicit
 * minimal environment (never `...process.env` — T7/M8 forbid it).
 */
declare class ExecError extends Error {
}
/** The child ran past its budget, so whatever it was doing may have happened. */
declare class ExecTimeoutError extends ExecError {
}
/**
 * Meant to be called once, wherever a caller owns config loading (config.ts
 * for daemon-wide binaries; today, once per `resolveInitiative` call, since
 * that resolution isn't yet wired through config.ts) — so a binary path
 * that is relative, missing, a directory, or not executable throws
 * immediately rather than becoming a `spawn ENOENT`/`EISDIR` (or worse, a
 * same-named program found on whatever `PATH` happens to be) the first time
 * an item needs it. `X_OK` alone accepts directories (POSIX: a directory is
 * "executable" meaning traversable), so a regular-file check comes first.
 */
declare function resolveBinaryPath(path: string, purpose: string): string;
/**
 * The explicit, minimal environment every subprocess call site starts from.
 *
 * `PATH` is seeded with `dirname(process.execPath)` ahead of the bare-bones
 * `/usr/bin:/bin` — not because a callee is ever found by searching `PATH`
 * (every call site here already resolves an absolute binary path first,
 * per this file's own header comment), but because a `#!/usr/bin/env node`
 * shebang script (`active-work`, resolved via `ACTIVE_WORK_BIN_PATH`) still
 * needs `env` to find *its own interpreter* in the CHILD's `PATH` once
 * launched. `/usr/bin:/bin` alone does not contain node on a Homebrew or
 * nvm install, which surfaced as a real `env: node: No such file or
 * directory` failure the first time this ran for real outside test fakes
 * (fakes are plain `#!/bin/sh` scripts, which never hit this). Using this
 * process's own interpreter directory rather than a hardcoded path keeps
 * the fix portable across machines instead of encoding one operator's
 * install location.
 *
 * `USER` is set for the same class of reason, discovered the same way (a
 * real spawn against production, not a fake in a test): the `claude` binary
 * itself authenticates via a macOS Keychain-stored credential, and that
 * lookup came back "Not logged in" under `PATH`+`HOME` alone but succeeded
 * the moment `USER` was present — some part of the Keychain resolution
 * path needs it to identify whose login keychain to open, independent of
 * `HOME` already pointing at the right home directory. Read via
 * `userInfo().username` (an OS-level syscall, `getpwuid`) rather than
 * `process.env.USER` — this file's own header comment forbids widening
 * from the caller's environment, and this keeps that true even for a
 * value that happens to usually match `$USER`.
 */
declare function minimalEnv(): Record<string, string>;
interface SafeExecResult {
    stdout: string;
    /**
     * Captured rather than inherited, because the two programs relay shells out to
     * split their failures across both streams: agent-chat prints a broker refusal
     * on stdout but a usage error — an unknown flag, a bad argument — through
     * `fail()` on stderr. A caller reading only stdout turns the entire second
     * category into a bare "exited 1" with the reason nowhere it can report it.
     */
    stderr: string;
    status: number;
}
/**
 * Runs `bin` with `args` and `env`, no shell involved at any point. Does not
 * throw on a non-zero exit — that is the callee's business to interpret
 * (P4: some non-zero exits are a refusal, not a crash) — but does throw
 * `ExecError` if the process could not be started at all, or timed out.
 *
 * `cwd` is optional because only one call site needs it and it must not be
 * settable by accident: `dispatch.ts` runs the `agent-chat` CLI, which sends
 * its OWN `process.cwd()` to the broker as the spawn location, so the child's
 * working directory is the only channel relay has for saying where the agent
 * should run. Everywhere else, inheriting this process's cwd is correct and
 * passing one would just be an unreviewed way to widen where a subprocess
 * reads from.
 *
 * `input` is stdin for the child, and exists for exactly one reason: argv is
 * world-readable via `ps`, so anything relay did not author itself — an item
 * body captured by voice — must not travel that way (R-68). It is the same
 * opt-in rule as `cwd`; a caller with nothing to hide passes nothing.
 */
declare function execSafe(bin: string, args: string[], env: Record<string, string>, timeoutMs: number, cwd?: string, input?: string): SafeExecResult;
/**
 * `execSafe` without blocking the event loop: same timeout, no-shell and
 * error mapping, for callers (a long-lived server) that cannot afford to
 * stall while a slow child answers. `input` and `cwd` follow `execSafe`'s
 * opt-in rule; `cwd` is last so existing `input` callers keep their order.
 * Aborting `signal` kills the child and rejects with `ExecAbortedError`; a
 * signal already aborted starts no child.
 */
declare function execSafeAsync(bin: string, args: string[], env: Record<string, string>, timeoutMs: number, input?: string, cwd?: string, signal?: AbortSignal): Promise<SafeExecResult>;

/**
 * R-61: hand a claimed item to agent-chat's own agent machinery instead of
 * spawning Claude ourselves.
 *
 * ## Why this shells out instead of importing
 *
 * agent-chat exposes exactly one subpath (`./spawn-kernel`), and that file
 * states the rule this module has to live with: "Nothing that spawns.
 * `run-agent.ts` in particular must never be exported from here — it builds
 * `env: { ...process.env }`, which is precisely what relay's own threat model
 * (T7/M8) forbids." There is no library equivalent of the `agent_spawn` MCP
 * tool, and the broker serves no spawn route over HTTP. The supported
 * programmatic surface is the CLI, which forwards a `{t:'spawn'}` frame over
 * the broker's 0600 unix socket.
 *
 * So: `execSafeAsync` against an absolute `agent-chat` path, argv array, minimal
 * env, exactly like `initiative.ts` already shells out to `active-work`.
 *
 * ## M8, and why the brief is not in argv (R-68)
 *
 * M8 (sources/agent-runner-threat-model.md) says nothing from an item body ever
 * reaches argv, and it closes T7 STRUCTURALLY. R-61 briefly downgraded that to
 * "practically safe": agent-chat's CLI took the brief as variadic argv, so a
 * body was world-readable via `ps` to any local process — a disclosure surface,
 * never an injection one, since `execFile` with `shell: false` and an argv
 * ARRAY never lets body content become a token another program parses.
 *
 * R-68 restored the structural version rather than leaving it a practice. The
 * brief goes to the child on stdin under `--brief-stdin`, added to agent-chat's
 * CLI following R-59's resume primitive; `buildSpawnArgs` returns an argv
 * carrying no item BODY, and `execSafeAsync`'s `input` carries it instead. The
 * remaining hops were already clean: the CLI sends the brief to the broker over
 * a 0600 unix socket, and `launch-plan.ts` gives a HEADLESS agent its brief on
 * stdin rather than in `claude`'s argv.
 *
 * Two things that are deliberately NOT claimed here, because a reviewer found
 * both overstated on 2026-08-10:
 *
 * - Headless is checked, not guaranteed. `assertInstalledHeadless` reads the
 *   installed profile just before the spawn (R-71 slice A), but the broker
 *   re-reads it afterwards, so a write in between still reaches
 *   `launch-plan.ts`'s interactive branch until agent-chat's surface lock lands.
 * - The initiative SLUG still travels in argv behind `--briefing`. It derives
 *   from an item tag, so it is item-derived text — bounded to a strict slug by
 *   `initiative.ts` before it gets here, but not nothing.
 *
 * This makes the daemon require an agent-chat new enough to know the flag. An
 * older one exits non-zero on the unknown option, which surfaces as a dispatch
 * refusal rather than a silent spawn with a missing brief.
 *
 * ## Privilege note
 *
 * The CLI reaches the broker as the HUMAN, and `supervisor.ts` exempts the
 * human from BOTH `checkSpawnCwd`'s location policy and the spawn-rate budget.
 * Those two controls do not apply to anything this module starts; the caller
 * must bound spawn volume itself (relay does it with a single-flight loop).
 *
 * ## What stayed in relay
 *
 * Profile names, peer-name derivation and profile installation are relay
 * policy, so the profile allowlist is the caller's `allowedProfiles` argument.
 */

/** Each class carries a fixed `name`, so a caller can record which kind of failure it was without its message. */
declare class DispatchError extends Error {
    readonly name: string;
}
/** The CLI could not connect to the broker, so nothing was asked of it; retrying later is safe. */
declare class BrokerUnavailableError extends DispatchError {
    readonly name: string;
}
/** The CLI did not answer in time, so the spawn or retire may already have happened. */
declare class DispatchTimeoutError extends DispatchError {
    readonly name: string;
}
/** Same shape agent-chat's own registry enforces, checked before we spend a spawn. */
declare const PEER_NAME_PATTERN: RegExp;
/**
 * Every agent-chat call runs with this; autostart would leave a broker owned by the caller.
 * A non-empty `AGENT_CHAT_HOME` is forwarded so the CLI reaches the broker whose
 * profiles `installedProfilesDir()` just checked, not the default one.
 */
declare function agentChatEnv(): Record<string, string>;
/**
 * Who started the agent, recorded on its roster row (CC-1466). A record only: agent-chat's gates read `--spawned-as`,
 * never this, so it widens nothing. Omitted means the argv is exactly what it was before the option existed.
 */
interface LaunchedBy {
    launchedBy?: "shepherd";
    /** Sent only alongside `launchedBy`. */
    launchReason?: string;
}
/** The roles agent-chat's `--role` accepts. */
type AgentRole = "implementer" | "reviewer" | "shepherd-review" | "planner" | "other" | `fix-round-${number}`;
/** A task id such as `tp/TP-12`: caller-derived, so it is checked to a strict shape before it reaches argv. */
declare const TASK_ID_PATTERN: RegExp;
/**
 * What the spawn records on the agent's own row, so later readers (Shepherd's successor walk, the roster) see who the
 * agent works for. Omitted fields leave their flags out of argv.
 */
interface AgentRecord {
    role?: AgentRole;
    task?: string;
}
interface DispatchRequest extends LaunchedBy, AgentRecord {
    agentChatBinPath: string;
    /** Derived by the caller, never taken from item content; unique per item, so a re-dispatch collides on purpose. */
    peerName: string;
    /** One of the caller's `allowedProfiles`; never anything an item could name. */
    profile: string;
    brief: string;
    /**
     * active-work slug, handed to agent-chat so ITS briefing auto-load runs.
     * Omitted for the reviewer, whose orientation is the worktree it lands in.
     */
    briefing?: string;
    /** The directory the CLI sends to the broker as the spawn location. */
    cwd: string;
    /** Claude config directory for the agent, such as a second account's; omitted means agent-chat's default. */
    configDir?: string;
    /** Where agent-chat's installed profiles live; omitted means `installedProfilesDir()`. */
    profilesDir?: string;
}
interface DispatchResult {
    peerName: string;
}
/**
 * Built as an array and returned rather than run, so a test can assert the
 * exact argv without starting anything — the same seam R-59's `resumeWithMessage`
 * uses on agent-chat's side.
 *
 * The brief is deliberately ABSENT from what this returns. It travels on the
 * child's stdin under `--brief-stdin` instead (R-68), because argv is
 * world-readable via `ps` and the brief is an item body relay did not author.
 * That makes "no item text in argv" a property this function's return value
 * demonstrates on its own, rather than one that depends on how carefully the
 * caller quotes — which is the whole difference between a structural guarantee
 * and a practice.
 */
declare function buildSpawnArgs(req: LaunchedBy & AgentRecord & SpawnPlacement & {
    peerName: string;
    profile: string;
    briefing?: string;
    configDir?: string;
}): string[];
/** Where and on which account agent-chat runs the agent; each omitted field leaves its flag out of argv. */
interface SpawnPlacement {
    /** A configured alias or hostname; omitted means the broker's own host. */
    host?: string;
    /** An account name, or `least-used` for the broker's pick. */
    account?: string;
    /** Overrides the profile's surface. */
    surface?: string;
    remoteControl?: boolean;
}
/**
 * Start the agent and return the name it was started under.
 *
 * Fire-and-forget by construction: the CLI exits as soon as the broker has
 * accepted the spawn, so a zero exit means "the agent was started", NOT "the
 * work is done". That is why `executor.ts` reports a non-terminal
 * `run_progress` rather than a terminal event — the run stays open for R-62 to
 * close from agent-chat's own event stream.
 */
declare function dispatchToAgentChat(req: DispatchRequest, timeoutMs: number, allowedProfiles: readonly string[]): Promise<DispatchResult>;

/**
 * A spawn made on behalf of whoever runs this process, a human in a terminal
 * or an agent in its Bash tool, rather than on behalf of a daemon.
 *
 * `dispatchToAgentChat` reaches the broker as the human on purpose: its
 * callers are daemons whose environment says nothing about who asked. Here the
 * caller's identity is the point. agent-chat's CLI reads `AGENT_CHAT_NAME` or
 * `AGENT_CHAT_AGENT_ID` to name the spawner, which keeps the coordinator depth
 * cap and the Remote Control rule on an agent's spawn, and `CLAUDE_CONFIG_DIR`
 * as the spawner's account, which a least-used pick prefers on a tie. Those
 * three are forwarded when set, and nothing else from the caller's
 * environment is.
 *
 * No profile allowlist or headless check: the caller names the profile, and
 * the broker applies the same gates to it as to any spawn the caller makes
 * with the CLI directly. The brief still travels on stdin.
 */

declare const CALLER_IDENTITY_VARS: readonly ["AGENT_CHAT_NAME", "AGENT_CHAT_AGENT_ID", "CLAUDE_CONFIG_DIR"];
interface SpawnAsCallerRequest extends SpawnPlacement {
    agentChatBinPath: string;
    name: string;
    profile: string;
    brief: string;
    /** The directory the CLI sends to the broker as the spawn location. */
    cwd: string;
    /** active-work slug whose orientation agent-chat prepends to the brief. */
    briefing?: string;
}
interface SpawnAsCallerResult {
    name: string;
    /** agent-chat's stdout, one entry per non-empty line, such as the account choice and the `Spawned` line. */
    lines: string[];
}
/** `agentChatEnv()` plus each identity variable the caller's environment has a non-empty value for. */
declare function callerEnv(source?: NodeJS.ProcessEnv): Record<string, string>;
/** Starts the agent as the caller; a zero exit means the broker accepted the spawn, not that the work is done. */
declare function spawnAsCaller(req: SpawnAsCallerRequest, timeoutMs: number): Promise<SpawnAsCallerResult>;

/**
 * Duration of each agent-chat CLI call, reported to opt-in observers so a
 * long-lived caller can tell a slow roster read from a slow spawn.
 *
 * Only the verb is reported. Later argv words carry peer names and, for a
 * spawn, `--briefing` text, so they never leave this module.
 */

type AgentChatCall = {
    verb: string;
    ms: number;
    outcome: "ok" | "refused" | "timeout" | "error";
};
/** Returns the unsubscribe. `now` is injectable so tests need no real waiting. */
declare function observeAgentChatCalls(report: (call: AgentChatCall) => void, options?: {
    now?: () => number;
}): () => void;

/**
 * Refuse a dispatch unless the profile agent-chat is about to load says
 * `"surface": "headless"` (relay R-71 slice A, ported from relay PR #59).
 *
 * agent-chat re-reads `<name>.json` from its profiles dir (`$AGENT_CHAT_HOME/profiles`,
 * default `~/.agent-chat/profiles`) on every spawn, and
 * a dispatched implementer holds `Write` and blanket `Bash`, neither
 * path-limited. So one agent can rewrite the installed profile to an
 * interactive surface, and the NEXT dispatch then puts its brief in `claude`'s
 * argv (agent-chat `launch-plan.ts`, interactive branch), where `ps` can read
 * it. That breaks M8.
 *
 * This reads the same file just before the spawn and fails closed on anything
 * but an explicit headless surface. A write between this read and the broker's
 * own read is still possible; the agent-chat surface lock (R-71 slice C)
 * closes that window.
 */
/**
 * agent-chat's own rule: `$AGENT_CHAT_HOME/profiles`, else
 * `$HOME/.agent-chat/profiles`. `||` rather than `??` so an empty variable
 * falls back instead of yielding a relative `profiles`. Resolved per call so
 * it tracks both variables. Read from `process.env` first because `homedir()`
 * sees the process-wide variable, not a worker thread's own env.
 */
declare function installedProfilesDir(): string;
declare function assertInstalledHeadless(profile: string, dir?: string): void;

/**
 * Resume an ENDED agent's Claude Code session with one more message: R-59's
 * `resumeWithMessage`, which starts a fresh `claude` process against the same
 * session id. Ported from relay's `daemon/src/session.ts`.
 *
 * The message text is never interpolated into a shell or a flag: this returns
 * an argv array, `execSafeAsync` runs it with `shell: false`, and the words stay one
 * opaque argument. Unlike a spawn brief, the message IS in argv and so is
 * visible via `ps`; see dispatch.ts's M8 note for that cost.
 *
 * Resuming a LIVE agent starts a second process on a transcript another process
 * is still writing, so callers decide liveness first; this module does not.
 *
 * `resumeAgent` is the broker-tracked form: it asks agent-chat to resume the
 * agent by name, so the roster sees the resumed session. Its message is in argv
 * too, until agent-chat takes it on stdin.
 */

declare class ResumeError extends Error {
}
interface ResumeAgentResult {
    name: string;
    /** agent-chat's report, verbatim: the transcript verdict and any warnings. */
    lines: string[];
}
/**
 * R-59's primitive, inlined as a shape assertion rather than imported: this
 * package takes no dependency on agent-chat's source tree (dispatch.ts's
 * header: the supported programmatic surface is the CLI). Kept byte-identical
 * to `resumeWithMessage` — `-p` is a BOOLEAN there, so the message is a
 * positional prompt, and the `--` guards a message that begins with a dash.
 */
declare function resumeArgs(sessionId: string, message: string): string[];
declare function buildResumeAgentArgs(name: string, message: string, launch?: LaunchedBy): string[];
/** Resume an ended agent on its own conversation, with `message` as its next turn; rejects with `DispatchError` on a refusal. */
declare function resumeAgent(agentChatBinPath: string, name: string, message: string, timeoutMs: number, launch?: LaunchedBy): Promise<ResumeAgentResult>;

/**
 * Park an exited agent's worktree through `agent-chat agent park` (CC-282): the
 * broker removes the tree when it is clean and pushed and keeps the branch, and
 * `agent resume` re-creates it later. The broker refuses a live, detached,
 * dirty, unpushed or shared tree; that refusal reaches the caller as a
 * `DispatchError` carrying the broker's reason.
 */
/** Removing a worktree is a git call on the broker's side, so this allows more than a roster read. */
declare const DEFAULT_PARK_TIMEOUT_MS = 60000;
interface ParkResult {
    name: string;
    /** agent-chat's report, verbatim: what was parked and how to bring it back. */
    lines: string[];
}
interface ParkOptions {
    /** Shepherd sets it: agent-chat would otherwise ask Shepherd itself whether the agent is in a fix round (CC-1470). */
    noFixRoundCheck?: boolean;
}
declare function buildParkArgs(name: string, options?: ParkOptions): string[];
/**
 * Remove the agent's worktree and keep its branch; rejects with `DispatchError` when the broker refuses. Async because
 * `agent park` may read the caller back (agent-chat asks Shepherd about a fix round), and a blocked caller cannot answer.
 * The timeout has no default, so no call path can leave a park waiting on the broker without a bound it chose.
 */
declare function parkAgent(agentChatBinPath: string, name: string, timeoutMs: number, options?: ParkOptions): Promise<ParkResult>;

/**
 * Read agent-chat's roster and retire an agent, through the same CLI boundary
 * and `execSafeAsync` discipline as dispatch.ts: absolute binary, argv array,
 * minimal env, no shell.
 *
 * The roster comes from `agent-chat agent ls --json`, a fold over the broker's
 * durable log, so it answers "has this agent ended" correctly whenever it is
 * asked. A row missing a field this module relies on is skipped rather than
 * guessed at: an invented status could strand a finished agent or resume one
 * that is still writing its transcript.
 */

/**
 * One `agent ls --json` row, as agent-chat's `lsJsonRow` writes it. The
 * optional fields are dropped when a row carries them with the wrong type,
 * so a consumer never sees a value the type does not describe.
 */
interface AgentRow {
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
    /**
     * The agent this one took over from; null when the broker says it took over
     * from no one. Absent when the broker does not report it, which proves nothing.
     */
    predecessor?: string | null;
    /** True on a row only `--include-retired` returns: an ended generation whose name the broker freed. */
    retired?: boolean;
}
/**
 * Every row the broker's log holds, retired generations included. `complete` is false when the installed agent-chat
 * predates `--include-retired`, so `rows` lacks the retired generations and cannot prove who spawned whom.
 */
interface AgentLineage {
    rows: AgentRow[];
    complete: boolean;
}
interface RetireResult {
    name: string;
    /** What the broker could not do on a successful retire, verbatim. */
    caveats: string[];
}
declare function buildListAgentsArgs(options?: {
    includeRetired?: boolean;
}): string[];
declare function buildRetireArgs(name: string, force?: boolean): string[];
/** Every agent the broker's log knows, live or ended; retired generations only with `includeRetired`. */
declare function listAgents(agentChatBinPath: string, timeoutMs: number, options?: {
    includeRetired?: boolean;
}): Promise<AgentRow[]>;
/**
 * The roster with retired generations, for a lineage walk. An agent-chat that predates the flag gets the plain roster,
 * marked incomplete, so a caller can refuse to prove independence instead of failing the read.
 */
declare function listAgentLineage(agentChatBinPath: string, timeoutMs: number): Promise<AgentLineage>;
interface RetireOptions {
    force?: boolean;
    /**
     * Who the broker's `agent_retired` event names as the actor. The CLI reads
     * it from `AGENT_CHAT_NAME`; absent, the broker records `human`.
     */
    caller?: string;
}
/**
 * Release the agent's isolation, end its process and free its name. `force`
 * discards uncommitted or unmerged work its worktree holds. Rejects with
 * `DispatchError` when the broker refuses.
 */
declare function retire(agentChatBinPath: string, name: string, timeoutMs: number, options?: RetireOptions): Promise<RetireResult>;
/** Throws `DispatchError` on a malformed payload; skips a malformed row. */
declare function parseAgentRows(stdout: string): AgentRow[];

/**
 * Message a live agent through `agent-chat debug send`: the broker delivers the
 * text as one channel message, which starts a turn in an idle session. Use it
 * for a live agent; `resumeAgent` is for an ended one. The CLI connects
 * unregistered, so the broker delivers the text from the human seat; a `source`
 * labels it as that wake source, without human provenance. Like
 * `resumeAgent`, the text is in argv, where `ps` shows it.
 */

/** Mirrors agent-chat's `WAKE_SOURCES`: the label a recipient sees instead of the owner typing. */
type WakeSource = "watchdog" | "shepherd" | "console";
interface MessageOptions {
    /** Sent as `--source`, so the message arrives labelled `wake_source=<source>` rather than as the owner's words. */
    source?: WakeSource;
}
/** `--` ends the options, so a text that begins with a dash stays one operand; `--source` must come before it. */
declare function buildMessageArgs(name: string, text: string, options?: MessageOptions): string[];
/**
 * Whether `messageAgent` can reach the agent a roster row names. An unregistered sender reaches only a connected
 * session, so a `detached` row (not exited, but nothing connected) is as unreachable as an `exited` one.
 */
declare function receivesMessages(row: Pick<AgentRow, "presence">): boolean;
/** Deliver `text` to the live agent `name`; rejects with `DispatchError` when the broker has no live session by that name. */
declare function messageAgent(agentChatBinPath: string, name: string, text: string, timeoutMs: number, options?: MessageOptions): Promise<void>;

/**
 * Wrap untrusted text (a CI log, a review, a file list) so an agent reads it as
 * data. Ported from agent-chat's burndown `dataFence`.
 */
/** The fence is one backtick longer than the longest run in `text`, at least three, so `text` cannot close it. */
declare function dataFence(label: string, text: string): string;
/**
 * The body of the last ```json fenced block in `text`, parsed; undefined when there is none. An agent's final report
 * ends with one, so the last block is the report even when earlier ones quote examples. A block whose body is not JSON
 * throws a SyntaxError rather than reading as no report, so a malformed report is never mistaken for a missing one.
 */
declare function lastFencedJson(text: string): unknown;

/** The label shape agent-chat's broker accepts, checked before a call is spent on it. */
declare const ASK_LABEL_PATTERN: RegExp;
interface AskRequest {
    /** The service label answers are read back under. */
    as: string;
    text: string;
    /** The task or gate the question is about; the owner's queue groups by it. */
    task?: string;
    /** Answers to offer the owner. */
    options?: string[];
    recommended?: string;
}
/** One answer or dismissal to an ask, as agent-chat's `answers --json` prints it. */
interface ServiceAnswer {
    msgId: string;
    /** The msg_id `askHuman` returned for the ask this settles. */
    questionId: string;
    outcome: "answered" | "dismissed";
    text: string;
    by: "human";
    /** Where the owner answered from, when agent-chat knows. */
    channel?: string;
    /**
     * The broker's marker, when it set one: `decided` for the decider's answer on the human's behalf, `human-endorsed` for a
     * human-approved relay. Kept as read, so a marker this package does not know reaches the caller rather than failing the page.
     */
    provenance?: string;
    at: number;
}
/** Pass `next` back as `since` to read only what is new. */
interface AnswersPage {
    answers: ServiceAnswer[];
    next?: string;
}
/** Files the question and returns its msg_id, the id its answer is read back by. */
declare function askHuman(agentChatBinPath: string, req: AskRequest, timeoutMs: number, signal?: AbortSignal): Promise<string>;
/** Answers and dismissals to `label`'s asks after `since`, oldest first. */
declare function readAnswers(agentChatBinPath: string, label: string, since: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<AnswersPage>;
/** Withdraws an ask nobody needs answered any more. A refusal means it is already closed. */
declare function dismissAsk(agentChatBinPath: string, msgId: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;

/** A file the plan names, with the line it points at when it gives one. */
interface TouchPoint {
    path: string;
    line?: number;
}
/**
 * The part of a plan about one slice: the section under a heading naming it, or, when no heading
 * does, every paragraph, list item and table row that mentions the slice id as a whole word.
 */
declare function planSliceExcerpt(plan: string, slice: string): string | null;
/** Backticked repo-relative paths in the text, first mention of each, with the first line number given. */
declare function touchPointsIn(text: string, limit: number): TouchPoint[];

interface GitState {
    /** ISO time the state was read; the packet labels the section with it because it goes stale. */
    capturedAt: string;
    baseRef: string;
    baseSha: string;
    headSha: string;
    /** One-line commits on HEAD that the base lacks. */
    ahead: string[];
    /** One-line base commits whose message names the task id. */
    landed: string[];
    /** Open pull requests naming the task id, when the reader can see them. */
    openPrs?: string[];
}
interface TaskCard {
    id: string;
    title?: string;
    status?: string;
    estimate?: string | number;
    doneWhen?: string[];
    notes?: string[];
}
/** Everything the packet reads, injected so the builder itself does no I/O. */
interface BootReaders {
    /** A file's text, or null when it is missing or unreadable. Relative paths resolve against the repo root. */
    readFile(path: string): string | null;
    exists(path: string): boolean;
    gitState(taskId: string): GitState | null;
    readTask(taskId: string): TaskCard | null;
}
interface ReadinessFacts {
    /** The command the repo wants run before a push, when the caller knows it. */
    verify?: string;
}

type BootSectionId = "git" | "task" | "plan" | "touchPoints" | "readiness";
interface BootPacketInput {
    task: {
        id: string;
    };
    /** The plan file and the slice id whose part of it the agent needs. */
    plan?: {
        path: string;
        slice: string;
    };
    repo: ReadinessFacts;
    /** Files to excerpt; defaults to the backticked paths in the plan slice. */
    touchPoints?: TouchPoint[];
    readers: BootReaders;
    options?: BootPacketOptions;
}
interface BootPacketOptions {
    /** Whole-packet budget in tokens. */
    budget?: number;
    /** Per-section caps in tokens; a section over its cap loses lines, or whole excerpts, from its end. */
    caps?: Partial<Record<BootSectionId, number>>;
    /** Sections to include, most important first; over budget, whole sections drop from the end. */
    priority?: BootSectionId[];
    maxTouchPoints?: number;
    /** Token counter for the budget; the default estimates from characters. */
    countTokens?: (text: string) => number;
}
interface BootSection {
    id: BootSectionId;
    title: string;
    text: string;
    tokens: number;
    truncated: boolean;
}
interface BootPacket {
    text: string;
    tokens: number;
    sections: BootSection[];
    /** Sections left out, with why: no source, or dropped to fit the budget. */
    omitted: Array<{
        id: BootSectionId;
        reason: string;
    }>;
}
declare const BOOT_PACKET_BUDGET = 6000;
declare const DEFAULT_BOOT_PRIORITY: readonly BootSectionId[];
/** About four characters a token for English and code; a real tokenizer can be passed in instead. */
declare function estimateTokens(text: string): number;
/**
 * The boot packet for an implementer: what the spawner already knows about the task's state, cut to a
 * token budget so it can ride in the first turn. Every read goes through `input.readers`.
 */
declare function bootPacket(input: BootPacketInput): BootPacket;

interface NodeBootReadersOptions {
    repoRoot: string;
    /** Absolute path of the git binary. */
    gitBin: string;
    baseRef?: string;
    /** The task store read, e.g. a `@titan-design/pm` task mapped to a card; the packet does not parse task files. */
    readTask: (taskId: string) => TaskCard | null;
    /** Open PRs naming the task, when the caller can query a forge. */
    openPrs?: (taskId: string) => string[];
    now?: () => Date;
}
/** Readers over a local checkout: files from disk, git state from the git binary, tasks from the caller. */
declare function nodeBootReaders(opts: NodeBootReadersOptions): BootReaders;

export { ASK_LABEL_PATTERN, type AgentChatCall, type AgentLineage, type AgentRecord, type AgentRole, type AgentRow, type AnswersPage, type AskRequest, BOOT_PACKET_BUDGET, type BootPacket, type BootPacketInput, type BootPacketOptions, type BootReaders, type BootSection, type BootSectionId, BrokerUnavailableError, CALLER_IDENTITY_VARS, DEFAULT_BOOT_PRIORITY, DEFAULT_PARK_TIMEOUT_MS, DispatchError, type DispatchRequest, type DispatchResult, DispatchTimeoutError, ExecError, ExecTimeoutError, type GitState, type LaunchedBy, type MessageOptions, type NodeBootReadersOptions, PEER_NAME_PATTERN, type ParkOptions, type ParkResult, type ReadinessFacts, type ResumeAgentResult, ResumeError, type RetireOptions, type RetireResult, type SafeExecResult, type ServiceAnswer, type SpawnAsCallerRequest, type SpawnAsCallerResult, type SpawnPlacement, TASK_ID_PATTERN, type TaskCard, type TouchPoint, type WakeSource, agentChatEnv, askHuman, assertInstalledHeadless, bootPacket, buildListAgentsArgs, buildMessageArgs, buildParkArgs, buildResumeAgentArgs, buildRetireArgs, buildSpawnArgs, callerEnv, dataFence, dismissAsk, dispatchToAgentChat, estimateTokens, execSafe, execSafeAsync, installedProfilesDir, lastFencedJson, listAgentLineage, listAgents, messageAgent, minimalEnv, nodeBootReaders, observeAgentChatCalls, parkAgent, parseAgentRows, planSliceExcerpt, readAnswers, receivesMessages, resolveBinaryPath, resumeAgent, resumeArgs, retire, spawnAsCaller, touchPointsIn };
