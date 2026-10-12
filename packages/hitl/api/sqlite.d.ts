import { Db, Migration } from '@titan-design/store-sqlite';
import { B as BaseGateStore, e as GateAuthorize, f as GateAnswerAllowance, g as GateEvidencePolicy, G as GateRecord, A as GateStatus } from './base-store.js';
import '@titan-design/authority';

declare const DEFAULT_GATE_TABLE = "hitl_gate";
declare function gateTableDdl(name?: string): string;
/** Drop into the product's own `runMigrations` list so hitl shares one database with its domain tables. */
declare function gateMigration(version: number, name?: string): Migration;
/**
 * The triggers that refuse a resolved row naming no resolver, on update and on
 * insert, so a writer that predates `resolved_by` fails loudly instead of resolving anonymously.
 */
declare function resolverRequiredTriggerDdl(name?: string): string;
/**
 * Adds `resolved_by` and the resolver trigger. Idempotent and backfill-free:
 * gates resolved before it keep an unknown resolver rather than a guessed one.
 */
declare function gateResolverMigration(version: number, name?: string): Migration;
/** Adds `rule` and its trigger. Idempotent and backfill-free: gates opened before it carry no rule. */
declare function gateRuleMigration(version: number, name?: string): Migration;
/** Adds `summary`, `evidence_ref` and `questions`. Idempotent and backfill-free: gates opened before it carry no brief. */
declare function gateBriefMigration(version: number, name?: string): Migration;
/**
 * Adds `resolved_evidence`. Idempotent and backfill-free: gates resolved before it carry no evidence. A store
 * refuses a resolve that carries evidence while the table lacks it, rather than drop the evidence.
 */
declare function gateEvidenceMigration(version: number, name?: string): Migration;
/**
 * Reinstalls the rule triggers to admit a delegate class the row's own rule names; a pending row's rule still cannot change. A
 * store refuses a gate with delegates until this runs, since no delegate could resolve it. Idempotent and backfill-free.
 */
declare function gateDelegateMigration(version: number, name?: string): Migration;
interface SqliteGateStoreOptions {
    table?: string;
    /** Run `gateMigration`, `gateResolverMigration`, `gateRuleMigration`, `gateBriefMigration`, `gateEvidenceMigration` and `gateDelegateMigration` on construction. Off when the product owns its migration list. */
    migrate?: boolean;
    now?: () => number;
    /** Refuses resolvers beyond the default class check; it cannot admit one the default refused. */
    authorize?: GateAuthorize;
    /** Refuse `create` without a `summary` and an `evidenceRef`. Off by default; needs `gateBriefMigration`. */
    requireBrief?: boolean;
    /** Answers a non-owner class may give, each exact in class, step and payload. Nothing else widens the default class check. */
    allowances?: readonly GateAnswerAllowance[];
    /** Admits a non-owner class on the evidence its resolve carries; see `GateEvidencePolicy`. Needs `gateEvidenceMigration`. */
    evidencePolicy?: GateEvidencePolicy;
}
/**
 * Durable gates. Two instances on the same file are two processes as far as the
 * gate is concerned, which is the entire point: whoever resolves the row does
 * not have to be whoever opened it.
 */
declare class SqliteGateStore extends BaseGateStore {
    private readonly db;
    private readonly table;
    private readonly columnsSeen;
    constructor(db: Db, options?: SqliteGateStoreOptions);
    /** Refuses rather than dropping a rule or a brief when the table has no column to hold it. */
    protected insert(record: GateRecord): void;
    private optionalColumns;
    protected read(id: string): GateRecord | undefined;
    /** Evidence is written only when given, so a table without `resolved_evidence` still settles every other resolve. */
    protected update(record: GateRecord): boolean;
    /** Only a present column is cached: a migration can add one while the store is open, never remove one. */
    private requireColumn;
    protected readByStatus(status: GateStatus): GateRecord[];
}

export { DEFAULT_GATE_TABLE, SqliteGateStore, type SqliteGateStoreOptions, gateBriefMigration, gateDelegateMigration, gateEvidenceMigration, gateMigration, gateResolverMigration, gateRuleMigration, gateTableDdl, resolverRequiredTriggerDdl };

// ./dist/base-store.d.ts
import { ResolverClass, DelegateResolverClass, ActorClass } from '@titan-design/authority';

/** A gate is a row, never a promise: pending work survives the process that opened it. */
type GateStatus = "pending" | "resolved" | "cancelled" | "expired";
/** A JSON Schema document, stored so any process can validate a payload without the original zod schema. */
type JsonSchema = Record<string, unknown>;
interface GateRecord {
    id: string;
    prompt: string;
    schema: JsonSchema | undefined;
    status: GateStatus;
    payload: unknown;
    /** Why the gate was cancelled; unset for every other status. */
    reason: string | undefined;
    /** ISO-8601 with milliseconds, the shape store-sqlite writes and any surface can send as-is. */
    createdAt: string;
    resolvedAt: string | undefined;
    expiresAt: string | undefined;
    /** Who resolved the gate, as claimed by the caller; unset for gates resolved before stores recorded it. */
    resolvedBy: GateResolver | undefined;
    /** The facts the resolver read when it answered, kept so an audit can re-check the decision; unset when none were given. */
    resolvedEvidence: GateEvidence | undefined;
    /** The authority rule that opened the gate; unset for a gate no rule governs. */
    rule: GateRule | undefined;
    /** One line for the owner: the decision and the recommendation. Unset for a gate opened without a brief. */
    summary: string | undefined;
    /** Where the owner checks the facts: an https URL, an absolute path, or `$ <command>`. */
    evidenceRef: string | undefined;
    /** A fixed menu a surface can render as buttons; the gate's `schema` still validates the answer. */
    questions: GateQuestion[] | undefined;
}
interface GateQuestionOption {
    /** 1-40 letters, digits, `-` or `_`; unique within its question. */
    id: string;
    /** 1-75 characters, the Slack button limit. */
    label: string;
    /** At most one option per question; omitted means false. */
    recommended?: true;
}
interface GateQuestion {
    /** 1-40 letters, digits, `-` or `_`; unique within the gate. */
    id: string;
    /** 1-500 characters. */
    question: string;
    /** 2-4 options. */
    options: GateQuestionOption[];
}
/** What the owner reads instead of the machine-facing prompt. A store with `requireBrief` refuses a gate without one. */
interface GateBrief {
    /** 1-280 characters on one line. */
    summary: string;
    /** 1-500 characters on one line. */
    evidenceRef: string;
    /** 1-4 questions; absent means the gate's schema alone defines the answer. */
    questions?: GateQuestion[];
}
/** Binds a gate to the authority rule that opened it, so only that rule's resolver classes may answer. */
interface GateRule {
    table: string;
    version: string;
    ruleId: string;
    resolvers: ResolverClass[];
    /**
     * Non-owner classes the rule lets answer too, drawn only from `DELEGATE_RESOLVER_CLASSES`. A delegate is admitted
     * only by a store that has `authorize`, and only when `authorize` allows it; SQLite needs `gateDelegateMigration`.
     */
    delegates?: DelegateResolverClass[];
}
/** A claim about who answered a gate. hitl records it and checks its class; it cannot prove it. */
interface GateResolver {
    class: ActorClass;
    id: string;
    channel: string;
    /** The channel's own id for the confirming event, such as a chat reaction. */
    confirmEvent?: string;
}
type GateAuthorization = {
    allowed: true;
} | {
    allowed: false;
    reason: string;
};
/**
 * Runs after the default resolver-class check, so it can refuse a resolver but
 * never admit one the default refused. Must return synchronously.
 */
type GateAuthorize = (gate: Readonly<GateRecord>, resolver: Readonly<GateResolver>) => GateAuthorization;
/**
 * One answer a non-owner class may give, declared by the product when it builds the store.
 * It admits exactly: `resolverClass`, a gate whose step is `stepId` (a bare id or `<id>:<n>` after
 * the last `/`), and a payload deep-equal to `payload`. Evaluated in place of the default refusal for
 * those gates only; the gate's rule and `authorize` still run after it. The resolver's id must be non-blank.
 */
interface GateAnswerAllowance {
    resolverClass: ActorClass;
    stepId: string;
    payload: Readonly<Record<string, unknown>>;
}
/** Plain JSON facts a resolver read at resolve time. hitl stores them on the row and never interprets them. */
type GateEvidence = Record<string, unknown>;
/**
 * Admits a non-owner resolve that the default refusal and every allowance refuse, but only on the evidence the resolver
 * gave. It sees the pending gate, so it can tie the evidence to the gate's own fields. Must be pure and synchronous, so an
 * audit can re-run it over the stored row; anything but `true`, or a throw, refuses. The rule and `authorize` still run after it.
 */
type GateEvidencePolicy = (gate: Readonly<GateRecord>, resolver: Readonly<GateResolver>, payload: unknown, evidence: Readonly<GateEvidence>) => boolean;
interface GateInput {
    /** Defaults to a random UUID. Supply one to make the gate addressable by a name you already own. */
    id?: string;
    prompt: string;
    schema?: JsonSchema;
    expiresAt?: Date | string;
    rule?: GateRule;
    /** Required, with `evidenceRef`, when the store has `requireBrief`. */
    summary?: string;
    evidenceRef?: string;
    questions?: GateQuestion[];
}
/**
 * Synchronous on purpose: both implementations are local (a Map, and
 * better-sqlite3), and `wait` is the only thing that needs to be async.
 */
interface GateStore {
    create(input: GateInput): GateRecord;
    get(id: string): GateRecord | undefined;
    /** `evidence` is stored with the resolution; with an `evidencePolicy` it can admit a class the default refuses. */
    resolve(id: string, payload: unknown, resolvedBy: GateResolver, evidence?: GateEvidence): GateRecord;
    cancel(id: string, reason: string): GateRecord;
    listPending(): GateRecord[];
}
declare class GateError extends Error {
    readonly gateId: string;
    constructor(message: string, gateId: string);
}
declare class GateNotFound extends GateError {
    constructor(gateId: string);
}
declare class GateAlreadyExists extends GateError {
    constructor(gateId: string);
}
declare class GateAlreadySettled extends GateError {
    readonly status: GateStatus;
    constructor(gateId: string, status: GateStatus);
}
declare class GateCancelled extends GateError {
    readonly reason: string;
    constructor(gateId: string, reason: string);
}
declare class GateExpired extends GateError {
    constructor(gateId: string);
}
declare class GatePayloadInvalid extends GateError {
    readonly issues: string[];
    constructor(gateId: string, issues: string[]);
}
declare class GateAborted extends GateError {
    constructor(gateId: string, reason: string);
}
declare class GateResolverRefused extends GateError {
    readonly actorClass: string | undefined;
    readonly reason: string;
    constructor(gateId: string, actorClass: string | undefined, reason: string);
}
/**
 * The store cannot record a resolver or a rule because its table predates the migration that adds the column.
 * `gateId` is empty when the store refuses at construction, before any gate is named.
 */
declare class GateStoreSchemaOutdated extends GateError {
    readonly table: string;
    readonly migration: string;
    constructor(gateId: string, table: string, migration: string);
}
declare class GateRuleInvalid extends GateError {
    readonly reason: string;
    constructor(gateId: string, reason: string);
}
declare class GateBriefInvalid extends GateError {
    readonly issues: string[];
    constructor(gateId: string, issues: string[]);
}
declare class GateEvidenceInvalid extends GateError {
    readonly reason: string;
    constructor(gateId: string, reason: string);
}
declare class GateExpiryInvalid extends GateError {
    readonly value: string;
    constructor(gateId: string, value: string);
}
declare class GateAuthorizeInvalid extends GateError {
    constructor(gateId: string);
}

/**
 * Every settle rule lives here so the memory and SQLite stores cannot drift
 * apart. Subclasses only move rows.
 */
declare abstract class BaseGateStore implements GateStore {
    protected readonly clock: () => number;
    private readonly authorize?;
    private readonly requireBrief;
    private readonly evidencePolicy?;
    protected constructor(clock: () => number, authorize?: GateAuthorize | undefined, requireBrief?: boolean, allowances?: readonly GateAnswerAllowance[], evidencePolicy?: GateEvidencePolicy | undefined);
    private readonly allowances;
    protected abstract insert(record: GateRecord): void;
    protected abstract read(id: string): GateRecord | undefined;
    /** Writes only while the stored row is still pending; false means another writer settled it first. */
    protected abstract update(record: GateRecord): boolean;
    protected abstract readByStatus(status: GateRecord["status"]): GateRecord[];
    create(input: GateInput): GateRecord;
    get(id: string): GateRecord | undefined;
    resolve(id: string, payload: unknown, resolvedBy: GateResolver, evidence?: GateEvidence): GateRecord;
    cancel(id: string, reason: string): GateRecord;
    listPending(): GateRecord[];
    private requirePending;
    /**
     * `authorize` runs between the pending check and the write, and another store may settle the row in that gap.
     * A writer that got there first with this same answer is a retry, not a conflict, so its row comes back.
     */
    private settle;
    /**
     * The default check (or a listed allowance, the evidence policy, or a rule-named delegate) runs first, the gate's rule
     * second and `authorize` last, so each can only narrow who may resolve. A delegate needs `authorize` to exist, so it
     * never skips that last check.
     */
    private requireAuthorized;
    /** Expiry is lazy: nothing sweeps the table, so a read is what notices the deadline passed. */
    private lapseIfExpired;
    protected nowIso(): string;
}

export { type GateStatus as A, BaseGateStore as B, GateStoreSchemaOutdated as C, type GateRecord as G, type JsonSchema as J, type GateQuestion as a, type GateStore as b, type GateResolver as c, type GateEvidence as d, type GateAuthorize as e, type GateAnswerAllowance as f, type GateEvidencePolicy as g, GateAborted as h, GateAlreadyExists as i, GateAlreadySettled as j, type GateAuthorization as k, GateAuthorizeInvalid as l, type GateBrief as m, GateBriefInvalid as n, GateCancelled as o, GateError as p, GateEvidenceInvalid as q, GateExpired as r, GateExpiryInvalid as s, type GateInput as t, GateNotFound as u, GatePayloadInvalid as v, type GateQuestionOption as w, GateResolverRefused as x, type GateRule as y, GateRuleInvalid as z };
