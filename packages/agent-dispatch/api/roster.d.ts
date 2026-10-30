import { J as JournalRow, c as AgentJournal } from '../ports.js';

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

export { AGENT_LIFECYCLES, AGENT_ORIGINS, type AgentExit, type AgentIdentity, type AgentLifecycle, AgentLog, type AgentOrigin, HUMAN, LAUNCHERS, type Launcher, type PredecessorFacts, type PredecessorResult, type PredecessorSource, type PresenceInput, type QueueItem, ROSTER_STATUSES, type RosterEntry, type RosterFilter, type RosterHidden, type RosterStatus, type RosterView, type TranscriptVerdict, callerName, filterRoster, foldAgent, groupByAgent, inferWorkRole, launchedByBroker, launcherOf, newestByName, pairPresence, predecessorFacts, predecessorSection, resolvePredecessor, stoppedAt, viewRoster };

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
