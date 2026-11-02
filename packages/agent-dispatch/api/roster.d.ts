import { J as JournalRow, c as AgentJournal } from '../ports.js';
import { A as AgentIdentity, R as RosterView, a as RosterHidden, Q as QueueItem } from '../types.js';
export { b as AGENT_LIFECYCLES, c as AGENT_ORIGINS, d as AgentExit, e as AgentLifecycle, f as AgentOrigin, H as HUMAN, L as LAUNCHERS, g as Launcher, l as launcherOf } from '../types.js';

/**
 * Fold one agent's rows, oldest first, into its identity.
 *
 * Pure: no database, no clock, no process. Returns undefined when the rows never establish an
 * identity: an `agent_attached` citing an id with no spawn row is a corrupt or truncated log,
 * and inventing a half-agent from it would put a row on the roster that nothing can resume or retire.
 *
 * `retired` is absorbing. It frees the name, so honouring a later row would resurrect an
 * identity whose name another agent may already hold.
 */
declare function foldAgent(rows: readonly JournalRow[]): AgentIdentity | undefined;
/**
 * When an agent stopped, for the reclaim grace window: its exit, else its last detach.
 * Never `lastEventAt`, which every refused retire's own `isolation_released` row advances.
 */
declare const stoppedAt: (agent: Pick<AgentIdentity, "exitedAt" | "detachedAt">) => number | undefined;

/** Group rows by the agent id they carry, preserving log order within each group. */
declare function groupByAgent(rows: readonly JournalRow[]): Map<string, JournalRow[]>;
/**
 * CC-1453: the broker launched this identity from a plan it can rebuild: a
 * spawn, or any teleport successor. A successor of a hand-started session is
 * recorded as adopted, because it keeps that session's inherited configuration,
 * but it was still launched here, so it resolves by name like a spawn does.
 */
declare const launchedByBroker: (agent: AgentIdentity) => boolean;
/**
 * Query surface over the identity rows. Every call re-reads the rows, so it can
 * never drift from the log the way a cached aggregate would.
 *
 * CC-1463: the fold is reused while the read returns the same rows. The log only
 * appends, so the same count ending in the same row object is the same list; a
 * store that builds fresh rows per read (a fake, a tail read inside a transaction)
 * just refolds.
 */
declare class AgentLog {
    private readonly journal;
    private folded;
    constructor(journal: AgentJournal);
    private agentEvents;
    private agentEventsFor;
    private all;
    roster(opts?: {
        includeRetired?: boolean;
    }): AgentIdentity[];
    get(id: string): AgentIdentity | undefined;
    /**
     * The most recently spawned identity still holding `name`.
     *
     * Only identities the broker launched are matched (`launchedByBroker`). This
     * is what `retire` and `resume` resolve through, and neither is meaningful for
     * a session the broker did not launch: there is no launch plan to relaunch and
     * no isolation to release. It also keeps them out of the name lease below —
     * nothing can bring a hand-started session back under its name, so leasing one
     * past its process would block a spawn on that name forever.
     */
    byName(name: string): AgentIdentity | undefined;
    /**
     * CC-408: a newer identity under the same name, retired or not.
     *
     * Teleport successors keep the name, so once the newest is retired `byName`
     * falls back to an older generation; resuming that would wake a stale session.
     * CC-959: an adopted successor counts too. A seat restarted by hand is adopted,
     * and `byName` cannot see it, so it would otherwise resume the older spawned row.
     * Not one whose name was derived from its directory: a session merely opened in
     * an agent's worktree takes the agent's name without meaning to replace it.
     */
    supersededBy(agent: AgentIdentity): AgentIdentity | undefined;
    /** CC-1453: a teleport successor retired before it ever attached never held the conversation, so it supersedes nothing. */
    private neverRan;
    /**
     * The identity adopted for a Claude Code session id, so a session that
     * reconnects or outlives a broker restart re-attaches instead of accumulating
     * one identity per registration.
     *
     * Matches adopted identities only. A spawned agent's session id is recorded in
     * the log, where every session on the machine can read it, so matching one
     * would make adoption a way to claim an agent's identity by quoting a field —
     * the hole `BrokerCore.claimable` closes for agent ids.
     */
    bySession(sessionId: string): AgentIdentity | undefined;
    /**
     * The uniqueness the schema no longer provides: a name is leased for as long
     * as any non-retired identity holds it, so a detached or finished agent still
     * owns its name and stays resumable under it.
     *
     * CC-124: except one that failed to start. It never ran, so there is nothing
     * to resume, and holding its name made the obvious retry refuse until someone
     * retired a corpse by hand.
     */
    nameIsClaimed(name: string): boolean;
    /** The identity holding the name lease `nameIsClaimed` describes, so a refusal can say who it is. */
    nameHolder(name: string): AgentIdentity | undefined;
    /**
     * Has this identity stood down for a successor?
     *
     * A query, not a lifecycle state, and deliberately: standing down lasts
     * seconds, so making it a state would put it in `pairPresence`'s switch and
     * force a rendering decision for a condition nobody will ever see on screen.
     */
    stoodDown(agentId: string): boolean;
    /** The identity this one teleported into, if it has one. */
    successorOf(agentId: string): AgentIdentity | undefined;
    /** An identity followed by each teleport successor in turn, oldest first; empty when it is unknown. */
    lineageFrom(agentId: string): AgentIdentity[];
    /**
     * The raw `meta` of an identity's spawn row.
     *
     * For the fields `AgentIdentity` deliberately does not model — `depth` and
     * `parent` are enforcement inputs rather than things a roster should show, and
     * teleport has to carry both across UNCHANGED (succession is not branching,
     * so an inherited depth is the whole point).
     */
    spawnMeta(agentId: string): Record<string, string>;
}

/** Every status the roster can show; `failed` is spawned but never registered: the process is gone and did no work (CC-95). */
declare const ROSTER_STATUSES: readonly ["starting", "running", "blocked", "stalled?", "reconnecting", "detached", "finished", "failed", "retired"];
/** How a paired identity and presence should render on the roster. */
type RosterStatus = (typeof ROSTER_STATUSES)[number];
interface PresenceInput {
    /** `registry.connFor(name) !== undefined`. */
    connected: boolean;
    /** Derived, never stored: the agent has an open `approval_request`. */
    blocked?: boolean;
    /** Registry idle time. Omit to opt out of stall reporting entirely. */
    idleMs?: number;
    /**
     * Idle time past which a connected agent reads as `stalled?`. No default: the
     * threshold is unvalidated policy and the spec section that was to define it
     * (§11.6) was never written, so a caller that has not chosen one gets no
     * guess — it gets `running`.
     */
    stalledAfterMs?: number;
}
interface RosterEntry {
    agent: AgentIdentity;
    status: RosterStatus;
    /**
     * Set when lifecycle and presence disagree in a way that should not be
     * possible. Not an event: there is no `agent_state_anomaly` kind, and adding
     * one would unfreeze the SSE contract. Callers surface it on the routing log.
     */
    anomaly?: string;
}
/**
 * Pair the durable lifecycle with ephemeral presence.
 *
 * Where the two disagree, presence wins — a live socket is direct evidence and a
 * lifecycle is an inference from rows that may have been missed. That choice is
 * what makes the agents view more truthful than the sessions view: during the
 * reconnect ladder a durable agent can only change presence, never vanish.
 */
declare function pairPresence(agent: AgentIdentity, presence: PresenceInput): RosterEntry;

interface RosterFilter {
    /** Keeps only agents spawned by this name; a successor sharing the name counts. */
    spawner?: string;
    prefix?: string;
}
declare function filterRoster(agents: AgentIdentity[], filter: RosterFilter): AgentIdentity[];
/**
 * CC-1464: the agent_list page. Broker and client both run it, so a new client
 * against an old broker, which ignores `view` and sends everything, shows the
 * same rows. Run on its own output it changes nothing.
 */
declare function viewRoster(agents: AgentIdentity[], view: RosterView): {
    agents: AgentIdentity[];
    hidden: RosterHidden;
};
/**
 * CC-491: one row per name, the newest non-retired one. A name recurs across
 * adoptions and resumes, and an older row's reading is not that agent today.
 */
declare function newestByName(agents: AgentIdentity[]): AgentIdentity[];
/** The name the CLI attributes to the caller: the one a spawned session registers under. */
declare function callerName(env?: NodeJS.ProcessEnv): string;

/** Where the conversation is, or would be, on disk. */
interface TranscriptVerdict {
    path: string;
    found: boolean;
}
/**
 * What the successor's briefing reads beyond the identity fold. The product supplies the message
 * lookup and the transcript check; the journal rows come from the same port the fold reads.
 */
interface PredecessorSource {
    /** The agent's own journal rows, oldest first. */
    rowsFor(agentId: string): readonly JournalRow[];
    /** Its newest message sent by `from` at or after `since`, optionally only to `to`. */
    lastMessageFrom(from: string, opts: {
        to?: string;
        since: number;
    }): QueueItem | undefined;
    transcriptOf(agent: AgentIdentity): TranscriptVerdict;
}
interface PredecessorFacts {
    agent: AgentIdentity;
    report?: QueueItem;
    branch?: string;
    worktree?: string;
    /** True when retire already removed the worktree, so the path is history rather than a place. */
    worktreeReleased: boolean;
    transcript: TranscriptVerdict;
}
type PredecessorResult = {
    text: string;
    warning?: string;
} | {
    error: string;
};
declare function predecessorFacts(source: PredecessorSource, agent: AgentIdentity): PredecessorFacts;
/** The briefing section a successor reads before its assignment. */
declare function predecessorSection(facts: PredecessorFacts): string;
/** The section for `name`, a refusal when it is not the requester's to hand over, or unknown. */
declare function resolvePredecessor(agents: AgentLog, source: PredecessorSource, name: string, requestedBy: string): PredecessorResult;

/** The role a spawner did not state, read from the agent's name first and its profile second. */
declare function inferWorkRole(profile: string, name: string): string;

/**
 * CC-266 and CC-255: what a headless agent was doing when it exited without the
 * return-contract report, read from the tail of its transcript.
 *
 * The broker decides WHETHER it reported from its own log; this module only
 * names the last action, for the spawner's notice and the digest. Its output
 * leaves the machine's private context, so a command becomes a short pattern
 * (`Bash(gh pr create)`) and never the command line, which can hold paths.
 */
/** The final turn fits well inside this; a megabyte transcript is never read whole. */
declare const EXIT_TAIL_BYTES: number;
declare const UNKNOWN_ACTION = "unknown";
declare const NO_TOOL_CALL = "no tool call";
/** The `meta.event` on the notice row, and what the digest groups by. */
declare const UNREPORTED_EXIT = "unreported-exit";
interface ExitTail {
    lastAction: string;
    pendingBackground: boolean;
}
type Block = Record<string, unknown>;
/** Never throws: a missing, unreadable or garbled transcript reads as `unknown`. */
declare function readExitTail(file: string | undefined, maxBytes?: number): ExitTail;
/** Pure: the last main-thread tool call and whether background work was still pending. */
declare function exitTailOf(text: string): ExitTail;
/** `mcp__plugin_x__chat_send` reads as `chat_send`; Bash keeps its program and an allowlisted verb. */
declare function actionPattern(toolUse: Block): string;
/** The spawner's notice: a clipped name and a bounded pattern, so it stays under 300 characters. */
declare function unreportedExitText(name: string, tail: ExitTail): string;

/**
 * CC-236: a path the brief names inside the cwd that resolves, through a symlink,
 * outside the cwd and every granted dir makes a headless worker's Write wait on a
 * prompt nobody answers. Advisory only: one warning per such path, never a refusal.
 */
declare function crossingBriefPaths(brief: string, cwd: string, grantedDirs: readonly string[]): string[];

/**
 * Mode switching (CC-23): move a running agent between headless and a terminal
 * window, keeping its identity, its conversation and its place in the roster.
 * Only the plan lives here: who may switch what, where a surfaced agent lands, and
 * what the switched agent is told. Stopping and relaunching the process is the product's.
 *
 * Surfacing may be aimed at another agent, because the case it exists for is an agent too
 * stuck to ask: a blocked headless agent is invisible to the view that would unblock it.
 * Backgrounding is self-only, with no target field at all, so one peer cannot make
 * another's work invisible.
 *
 * A switch stops the process and resumes from the transcript, so an in-flight turn is lost.
 */
/** A placement the surface ladder understands; a surfaced agent lands on one of these. */
type SurfacePlacement = "iterm-tab" | "iterm-pane";
/** Told to an agent that has just been pulled into a terminal by someone else. */
declare const SURFACED_NOTICE: string;
/** The continuation turn a backgrounded agent resumes on, since `-p` refuses without one. */
declare const BACKGROUNDED_BRIEF: string;
interface SwitchOutcome {
    ok: boolean;
    reason?: string;
    name?: string;
    agentId?: string;
    /** Where it actually landed, which the placement ladder may have downgraded. */
    surface?: string;
    warnings?: string[];
}
/**
 * Where a surfaced agent should appear: beside its requester when the requester has a
 * window, otherwise in a window of its own. With no anchor `iterm-tab` falls down the
 * ladder to a new window, which needs no anchor and so cannot fail to find one.
 */
declare function placementFor(anchor: string | undefined): SurfacePlacement;
/** Can this agent be pulled into a terminal, and is there any point? */
declare function checkSurfaceable(identity: AgentIdentity | undefined, name: string): string | undefined;
/**
 * Can this agent send ITSELF headless?
 *
 * `hostPid` is refused rather than worked around: signalling the MCP subprocess instead of
 * Claude Code severs the bus and leaves a live session no peer can reach and that cannot tell.
 */
declare function checkBackgroundable(identity: AgentIdentity | undefined, name: string, hostPid: number | undefined): string | undefined;

/**
 * CC-126: bringing an agent back WITH its conversation. The pure half: the decisions a
 * resume makes from an identity, a transcript verdict and a directory check the product supplies.
 * Finding the transcript, re-creating a removed worktree and launching stay with the product.
 *
 * Two routes, because retire is absorbing. An agent that finished or detached still holds its
 * identity and name, so a resume relaunches that identity. A retired one has given its name
 * up, so it comes back as a new identity that resumes its session id.
 *
 * Durable identity is not durable context: `--resume` replays a transcript Claude Code owns and
 * may have reaped. A missing transcript is refused rather than launched, since `claude --resume`
 * on an unknown id exits without doing anything.
 */
/** A removed worktree that can be re-created, and the repository it was cut from. */
interface ReattachTree {
    gitRoot: string;
    worktree: string;
    branch: string;
    adopted?: boolean;
}
/** The turn a headless resume starts on when the coordinator sent nothing to say. */
declare const RESUMED_BRIEF: string;
declare const verdictLine: (t: TranscriptVerdict) => string;
/** CC-1472: why an identity cannot be resumed on any host, from its record alone. */
declare function identityBlocker(agent: AgentIdentity): string | undefined;
/**
 * Why an identity cannot be resumed, or undefined when it can. `reattach` says its gone
 * worktree can come back; `cwdExists` is the product's directory check.
 */
declare function resumeBlocker(agent: AgentIdentity, transcript: TranscriptVerdict, cwdExists: (dir: string) => boolean, reattach?: ReattachTree): string | undefined;
/** The refusal for a name nothing live holds, pointing a retired one at the spawn route. */
declare function missingAgent(name: string, retired: AgentIdentity | undefined, gone?: ReattachTree): string;
/** The reply to a resume, shared by every surface so each says the same thing. */
declare function describeResume(name: string, res: {
    ok: boolean;
    reason?: string;
    transcript?: TranscriptVerdict;
    warnings?: string[];
    deduped?: boolean;
    /** CC-1472: the machine a host resume launched on. */
    host?: string;
}): {
    ok: boolean;
    lines: string[];
};

/**
 * CC-915: what a later task-to-eval exporter and throughput model need about an agent that
 * nothing else keeps. A squash merge and branch cleanup lose a worktree's base commit for good,
 * and a role read back out of a profile name is a guess, so both are written on the agent's own
 * rows while they are known.
 */
declare const WORK_ROLES: readonly ["implementer", "reviewer", "shepherd-review", "planner", "other"];
/** One of {@link WORK_ROLES}, or `fix-round-<n>` for Shepherd's n-th fix round. */
type WorkRole = (typeof WORK_ROLES)[number] | `fix-round-${number}`;
declare const isWorkRole: (value: string) => value is WorkRole;
declare const WORK_ROLE_CHOICES: string;
interface ExperimentArm {
    id: string;
    arm: string;
}
/** Runs `git <args>` in `cwd`; null when git fails, so a missing config reads as absent. */
type GitRunner = (args: string[], cwd: string) => Promise<string | null>;
/** What provenance reads of an allocation: the ref the isolation strategy recorded. */
interface ProvenanceAllocation {
    cwd: string;
    ref?: Record<string, string>;
}
/** `owner/name` of a GitHub remote URL; undefined for any other remote. */
declare const githubRepoOf: (url: string) => string | undefined;
/**
 * The worktree half of the provenance, as row meta: repo, branch and base. A
 * branch this allocation did not cut records no base rather than a wrong one; a
 * non-worktree allocation records nothing.
 */
declare function worktreeProvenance(allocation: ProvenanceAllocation, git: GitRunner): Promise<Record<string, string>>;
/** CC-168: frames arrive from more than one surface, so the shape is checked here and not only by the tool. */
declare const isExperimentArm: (value: unknown) => value is ExperimentArm;
/**
 * A burndown spawn always runs a task, so one without an id is a caller bug that
 * would leave the run unattributable; a role outside the vocabulary is refused
 * rather than recorded, since the exporter groups by it.
 */
declare function assignmentRefusal(req: {
    task?: string;
    workRole?: string;
    spawnedAs?: string;
    experiment?: ExperimentArm;
}): string | undefined;
type AssignmentRequest = {
    task?: string;
    workRole?: string;
    name: string;
    experiment?: ExperimentArm;
    slice?: string;
    routeOverride?: string;
    /** The `route_*` meta a dispatcher decided; only the keys `/routing` defines are written. */
    route?: Readonly<Record<string, string>>;
};
/** The task and role half, as row meta; `work_role_inferred` marks a role nobody stated. */
declare function assignmentMeta(req: AssignmentRequest, profile: string): Record<string, string>;
/** Everything a spawn row carries: the worktree half from the allocation, the assignment half from the request. */
declare function spawnProvenance(allocation: ProvenanceAllocation, req: AssignmentRequest, profile: string, git: GitRunner): Promise<Record<string, string>>;
/**
 * A teleport successor stands in its predecessor's tree on its predecessor's task,
 * so it carries the predecessor's folded provenance rather than re-deriving it: the
 * fold already holds a base a fresh-branch resume replaced, and a stated role stays
 * stated rather than becoming a guess from the profile.
 */
declare function successorProvenance(predecessor: AgentIdentity | undefined): Record<string, string>;

export { AgentIdentity, AgentLog, type AssignmentRequest, BACKGROUNDED_BRIEF, EXIT_TAIL_BYTES, type ExitTail, type ExperimentArm, type GitRunner, NO_TOOL_CALL, type PredecessorFacts, type PredecessorResult, type PredecessorSource, type PresenceInput, type ProvenanceAllocation, QueueItem, RESUMED_BRIEF, ROSTER_STATUSES, type ReattachTree, type RosterEntry, type RosterFilter, RosterHidden, type RosterStatus, RosterView, SURFACED_NOTICE, type SurfacePlacement, type SwitchOutcome, type TranscriptVerdict, UNKNOWN_ACTION, UNREPORTED_EXIT, WORK_ROLES, WORK_ROLE_CHOICES, type WorkRole, actionPattern, assignmentMeta, assignmentRefusal, callerName, checkBackgroundable, checkSurfaceable, crossingBriefPaths, describeResume, exitTailOf, filterRoster, foldAgent, githubRepoOf, groupByAgent, identityBlocker, inferWorkRole, isExperimentArm, isWorkRole, launchedByBroker, missingAgent, newestByName, pairPresence, placementFor, predecessorFacts, predecessorSection, readExitTail, resolvePredecessor, resumeBlocker, spawnProvenance, stoppedAt, successorProvenance, unreportedExitText, verdictLine, viewRoster, worktreeProvenance };

// ./dist/ports.d.ts
/**
 * The seams the dispatch fold reads and writes through. Each shape follows what
 * agent-chat's supervisor touches today, so a product adapter (the broker's event
 * store, a registry, a claim table) satisfies a port without translation.
 */
/** One durable lifecycle row. The spawn row mints the agent id; every later row cites it in `ref`. */
interface JournalRow {
    kind: string;
    ts: number;
    actor: string;
    target: string | null;
    msgId: string | null;
    ref: string | null;
    body: string | null;
    meta: Record<string, string>;
}
/** The append-only log the roster folds. Order of append is the order of the fold. */
interface AgentJournal {
    append(row: JournalRow): void;
    /** Every row, oldest first. */
    rows(): readonly JournalRow[];
    /** The fold input for one agent: its spawn row and each row citing it, oldest first. */
    rowsFor(agentId: string): readonly JournalRow[];
}
/** How a name's live connection relates to an agent: none, that agent, or another one. */
type NamePresence = 'none' | 'self' | 'other';
/** Ephemeral presence: dies with a socket, unlike the journal. */
interface PresencePort {
    /** The agent id bound to the name's connection, `null` when connected but unbound, `undefined` when not connected. */
    boundAgent(name: string): string | null | undefined;
    namePresence(name: string, agentId: string): NamePresence;
}
interface AdmissionRequest {
    agentId: string;
    name: string;
    /** The harness the launch is for, so a verdict can differ per harness. */
    harness?: string;
}
type AdmissionVerdict = {
    admitted: true;
} | {
    admitted: false;
    reason: string;
};
/** What a readmit of an already-admitted launch concluded. */
type ReadmitOutcome = 'readmitted' | 'unchanged' | 'refused';
/** The launch-integrity seam: types only here; the state machine lives behind an adapter. */
interface AdmissionLedger {
    admit(request: AdmissionRequest): AdmissionVerdict;
    verdict(agentId: string): AdmissionVerdict | undefined;
    readmit(agentId: string): ReadmitOutcome;
}
/** Why a tree must not be reclaimed on retire. Absent is no hold. */
interface RetireHoldPort {
    holdFor(tree: string): string | undefined;
}
interface DispatchHost {
    journal: AgentJournal;
    presence: PresencePort;
    admission: AdmissionLedger;
    retireHold: RetireHoldPort;
}

export type { AdmissionRequest as A, DispatchHost as D, JournalRow as J, NamePresence as N, PresencePort as P, ReadmitOutcome as R, AdmissionLedger as a, AdmissionVerdict as b, AgentJournal as c, RetireHoldPort as d };

// ./dist/types.d.ts
/** The identity shapes the roster folds into. Mirrors agent-chat's protocol so a product adapter needs no translation. */
declare const AGENT_LIFECYCLES: readonly ["spawning", "live", "detached", "exited", "retired"];
type AgentLifecycle = (typeof AGENT_LIFECYCLES)[number];
declare const AGENT_ORIGINS: readonly ["spawned", "adopted"];
type AgentOrigin = (typeof AGENT_ORIGINS)[number];
declare const LAUNCHERS: readonly ["seat-watchdog", "shepherd"];
type Launcher = (typeof LAUNCHERS)[number];
declare const launcherOf: (value: unknown) => Launcher | undefined;
/** The principal that stands for a person at the keyboard. */
declare const HUMAN = "human";
interface AgentExit {
    code: number | null;
    summary: string;
    costUsd?: number;
    failedToStart?: boolean;
    inferred?: boolean;
}
/** A durable agent identity: who it is, never whether it is plugged in. */
interface AgentIdentity {
    agentId: string;
    name: string;
    profile: string;
    state: AgentLifecycle;
    origin: AgentOrigin;
    spawnedBy: string;
    launchedBy?: Launcher;
    spawnedAt: number;
    /** Read off the spawn row on demand; not enumerable, so a serialised roster leaves it out. */
    brief: string;
    cwd: string;
    isolation: string;
    surface: string;
    sessionId: string;
    configDir?: string;
    configDirUnset?: boolean;
    host?: string;
    provisionalName?: true;
    repo?: string;
    branch?: string;
    base?: {
        sha: string;
        ref: string;
    };
    task?: string;
    workRole?: string;
    workRoleInferred?: true;
    lastEventAt: number;
    exitedAt?: number;
    detachedAt?: number;
    generation: number;
    teleportFrom?: string;
    /** `null` when the spawn row records none; absent when the row cannot say. */
    predecessor?: string | null;
    exit?: AgentExit;
}
/** What an agent-list page asks the roster to cut. */
interface RosterView {
    spawner?: string;
    prefix?: string;
    includeFinished?: boolean;
    includeRetired?: boolean;
    limit?: number;
}
/** How many rows each cut dropped, so a reader knows the page is not the whole roster. */
interface RosterHidden {
    finished: number;
    retired: number;
    overLimit: number;
}
/** A message read back from the log, as a report to carry into a successor's brief. */
interface QueueItem {
    msgId: string;
    kind: string;
    from: string;
    text: string;
    at: number;
    meta: Record<string, string>;
}

export { type AgentIdentity as A, HUMAN as H, LAUNCHERS as L, type QueueItem as Q, type RosterView as R, type RosterHidden as a, AGENT_LIFECYCLES as b, AGENT_ORIGINS as c, type AgentExit as d, type AgentLifecycle as e, type AgentOrigin as f, type Launcher as g, launcherOf as l };
