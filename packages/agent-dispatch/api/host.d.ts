import { D as DispatchHost, A as AdmissionRequest } from '../ports.js';
export { a as AdmissionLedger, b as AdmissionVerdict, c as AgentJournal, J as JournalRow, N as NamePresence, P as PresencePort, R as ReadmitOutcome, d as RetireHoldPort } from '../ports.js';

interface MemoryHost extends DispatchHost {
    /** Bind a live connection to a name; `agentId` omitted reads as connected but unbound. */
    connect(name: string, agentId?: string): void;
    disconnect(name: string): void;
    /** Hold a tree against retire with a reason. */
    hold(tree: string, reason: string): void;
    release(tree: string): void;
    /** Every `admit` call, in order. */
    admitted(): readonly AdmissionRequest[];
}
declare function memoryHost(): MemoryHost;

export { AdmissionRequest, DispatchHost, type MemoryHost, memoryHost };

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
