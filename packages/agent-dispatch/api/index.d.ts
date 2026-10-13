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
interface DispatchRequest {
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
declare function buildSpawnArgs(req: {
    peerName: string;
    profile: string;
    briefing?: string;
    configDir?: string;
}): string[];
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
declare function buildResumeAgentArgs(name: string, message: string): string[];
/** Resume an ended agent on its own conversation, with `message` as its next turn; rejects with `DispatchError` on a refusal. */
declare function resumeAgent(agentChatBinPath: string, name: string, message: string, timeoutMs: number): Promise<ResumeAgentResult>;

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
declare function buildParkArgs(name: string): string[];
/**
 * Remove the agent's worktree and keep its branch; rejects with `DispatchError` when the broker refuses. Async because
 * `agent park` may read the caller back (agent-chat asks Shepherd about a fix round), and a blocked caller cannot answer.
 */
declare function parkAgent(agentChatBinPath: string, name: string, timeoutMs?: number): Promise<ParkResult>;

/**
 * Message a live agent through `agent-chat debug send`: the broker delivers the
 * text as one channel message, which starts a turn in an idle session. Use it
 * for a live agent; `resumeAgent` is for an ended one. The CLI connects
 * unregistered, so the broker delivers the text from the human seat. Like
 * `resumeAgent`, the text is in argv, where `ps` shows it.
 */
/** `--` ends the options, so a text that begins with a dash stays one operand. */
declare function buildMessageArgs(name: string, text: string): string[];
/** Deliver `text` to the live agent `name`; rejects with `DispatchError` when the broker has no live session by that name. */
declare function messageAgent(agentChatBinPath: string, name: string, text: string, timeoutMs: number): Promise<void>;

/**
 * Wrap untrusted text (a CI log, a review, a file list) so an agent reads it as
 * data. Ported from agent-chat's burndown `dataFence`.
 */
/** The fence is one backtick longer than the longest run in `text`, at least three, so `text` cannot close it. */
declare function dataFence(label: string, text: string): string;

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
}
interface RetireResult {
    name: string;
    /** What the broker could not do on a successful retire, verbatim. */
    caveats: string[];
}
declare function buildListAgentsArgs(): string[];
declare function buildRetireArgs(name: string, force?: boolean): string[];
/** Every agent the broker's log knows, live or ended. */
declare function listAgents(agentChatBinPath: string, timeoutMs: number): Promise<AgentRow[]>;
/**
 * Release the agent's isolation, end its process and free its name. `force`
 * discards uncommitted or unmerged work its worktree holds. Rejects with
 * `DispatchError` when the broker refuses.
 */
declare function retire(agentChatBinPath: string, name: string, timeoutMs: number, options?: {
    force?: boolean;
}): Promise<RetireResult>;
/** Throws `DispatchError` on a malformed payload; skips a malformed row. */
declare function parseAgentRows(stdout: string): AgentRow[];

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

export { ASK_LABEL_PATTERN, type AgentRow, type AnswersPage, type AskRequest, BrokerUnavailableError, DEFAULT_PARK_TIMEOUT_MS, DispatchError, type DispatchRequest, type DispatchResult, DispatchTimeoutError, ExecError, ExecTimeoutError, PEER_NAME_PATTERN, type ParkResult, type ResumeAgentResult, ResumeError, type RetireResult, type SafeExecResult, type ServiceAnswer, agentChatEnv, askHuman, assertInstalledHeadless, buildListAgentsArgs, buildMessageArgs, buildParkArgs, buildResumeAgentArgs, buildRetireArgs, buildSpawnArgs, dataFence, dismissAsk, dispatchToAgentChat, execSafe, execSafeAsync, installedProfilesDir, listAgents, messageAgent, minimalEnv, parkAgent, parseAgentRows, readAnswers, resolveBinaryPath, resumeAgent, resumeArgs, retire };
