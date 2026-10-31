import { ZodType } from 'zod';
import { G as GateRecord, a as GateQuestion, b as GateRule, c as GateStore, d as GateResolver, e as GateEvidence, B as BaseGateStore, f as GateAuthorize, g as GateAnswerAllowance, h as GateEvidencePolicy } from './base-store.js';
export { i as GateAborted, j as GateAdmission, k as GateAdmittedBy, l as GateAlreadyExists, m as GateAlreadySettled, n as GateAuthorization, o as GateAuthorizeInvalid, p as GateBrief, q as GateBriefInvalid, r as GateCancelled, s as GateError, t as GateEvidenceInvalid, u as GateExpired, v as GateExpiryInvalid, w as GateInput, x as GateNotFound, y as GatePayloadInvalid, z as GateQuestionOption, A as GateResolverRefused, C as GateRuleInvalid, D as GateStatus, E as GateStoreSchemaOutdated, J as JsonSchema } from './base-store.js';
import { AnchorPins, RevisionSource } from '@titan-design/evidence';
import '@titan-design/authority';

declare const DEFAULT_POLL_MS = 250;
interface OpenGateOptions<T> {
    id?: string;
    prompt: string;
    /** Stored as JSON Schema so the resolving process can validate without it, and reused here to type the answer. */
    schema?: ZodType<T>;
    expiresAt?: Date | string;
    /** Required, with `evidenceRef`, when the store has `requireBrief`. */
    summary?: string;
    evidenceRef?: string;
    questions?: GateQuestion[];
    /** Binds the gate to the authority rule that opened it; see `GateRule`. */
    rule?: GateRule;
}
interface WaitOptions<T> {
    pollMs?: number;
    signal?: AbortSignal;
    /** Needed only when re-attaching to a gate this process did not open. */
    schema?: ZodType<T>;
}
interface GateHandle<T> {
    id: string;
    record: GateRecord;
    wait(options?: Omit<WaitOptions<T>, "schema">): Promise<T>;
}
/**
 * Open a gate and hand back something to await. The row exists before this
 * returns, so a crash here leaves a resolvable gate rather than a lost one.
 */
declare function openGate<T = unknown>(store: GateStore, options: OpenGateOptions<T>): GateHandle<T>;
/**
 * Await a gate by id from any process, including one that restarted after the
 * gate was opened. Polls rather than subscribes because the resolver may be a
 * different process writing the same SQLite file.
 */
declare function waitForGate<T = unknown>(store: GateStore, id: string, options?: WaitOptions<T>): Promise<T>;
/** Resolve a gate from wherever the human answered: a CLI, an MCP tool, a dashboard route. */
declare function resolveGate(store: GateStore, id: string, payload: unknown, resolvedBy: GateResolver, evidence?: GateEvidence): GateRecord;
declare function cancelGate(store: GateStore, id: string, reason: string): GateRecord;

interface MemoryGateStoreOptions {
    /** Epoch-millis clock, injectable so expiry is testable without waiting. */
    now?: () => number;
    /** Refuses resolvers beyond the default class check; it cannot admit one the default refused. */
    authorize?: GateAuthorize;
    /** Refuse `create` without a `summary` and an `evidenceRef`. Off by default. */
    requireBrief?: boolean;
    /** Answers a non-owner class may give, each exact in class, step and payload. Nothing else widens the default class check. */
    allowances?: readonly GateAnswerAllowance[];
    /** Admits a non-owner class on the evidence its resolve carries; see `GateEvidencePolicy`. */
    evidencePolicy?: GateEvidencePolicy;
}
/**
 * In-process gates. Right for tests and for a single-process product that only
 * needs the pause, not the durability; anything that must survive a restart
 * wants `SqliteGateStore`.
 */
declare class MemoryGateStore extends BaseGateStore {
    private readonly rows;
    constructor(options?: MemoryGateStoreOptions);
    protected insert(record: GateRecord): void;
    protected read(id: string): GateRecord | undefined;
    protected update(record: GateRecord): boolean;
    protected readByStatus(status: GateRecord["status"]): GateRecord[];
}

/**
 * The default refusal: only an owner class may resolve a gate, so an agent or
 * automation never answers its own gate. Every store applies it before `authorize`.
 */
declare function defaultResolverRefusal(resolver: GateResolver): string | undefined;
/** True when an allowance names this resolver's class, the gate's step and exactly this payload. The store and its callers share this test. */
declare function matchesAllowance(allowances: readonly GateAnswerAllowance[], gateId: string, resolver: GateResolver, payload: unknown): boolean;
/**
 * A rule-bound gate admits only its rule's resolver classes, and its delegates when the store has `authorize`.
 * Runs after the default refusal, so it only narrows.
 */
declare function ruleResolverRefusal(record: GateRecord, resolver: GateResolver, hasAuthorize?: boolean): string | undefined;
/**
 * Reads each declared field exactly once into a frozen plain object, so the
 * checks and the stored row see the same resolver and nothing undeclared is kept.
 */
declare function snapshotResolver(gateId: string, raw: unknown): Readonly<GateResolver>;

/*!
 * The question bounds and `questionsIssue` are adapted from openrig,
 * https://github.com/mvschwarz/openrig, packages/daemon/src/domain/human-questions.ts
 * (parseHumanQuestions). Copyright 2026 Mike Schwarz, licensed under the Apache License 2.0,
 * http://www.apache.org/licenses/LICENSE-2.0.
 * Changed here: the checks report through GateBriefInvalid instead of a result union, and
 * `recommended` keeps only `true`.
 * @license Apache-2.0
 */

interface GateBriefSnapshot {
    summary: string | undefined;
    evidenceRef: string | undefined;
    questions: GateQuestion[] | undefined;
}
/** The pinned commits and their file text, against which an anchor-form evidenceRef is checked. */
interface BriefAnchorCheck {
    pins: AnchorPins;
    source: RevisionSource;
}
/**
 * Checks the brief fields and returns a copy holding only the declared ones, so a caller
 * cannot change the stored questions after `create`. `required` makes `summary` and `evidenceRef` mandatory; without it they are still checked when present.
 * With `anchors`, an evidenceRef written as an anchor (`head/<path>#L10-L20`) must hold at its pinned commit; free text stays legal.
 */
declare function snapshotBrief(gateId: string, raw: unknown, required: boolean, anchors?: BriefAnchorCheck): Readonly<GateBriefSnapshot>;

/**
 * A deliberately small structural check over the JSON Schema subset `z.toJSONSchema`
 * emits. It exists so the process that resolves a gate can reject a bad payload
 * without holding the original zod schema, which by definition lives in another
 * process. The waiter still re-validates with the real zod schema, so this is the
 * boundary check, not the type guarantee.
 *
 * A stored schema is parsed once into a `SchemaNode`, and `parseSchema` is the only
 * reader of the raw value. Whatever it cannot read, an unknown keyword included,
 * becomes the one refusal below, so no value can pass as an open schema by being
 * misread. The checker walks typed nodes and has no malformed case of its own.
 */
declare function checkAgainstJsonSchema(schema: unknown, value: unknown, path?: string): string[];

export { BaseGateStore, DEFAULT_POLL_MS, GateAnswerAllowance, GateAuthorize, type GateBriefSnapshot, GateEvidence, GateEvidencePolicy, type GateHandle, GateQuestion, GateRecord, GateResolver, GateRule, GateStore, MemoryGateStore, type MemoryGateStoreOptions, type OpenGateOptions, type WaitOptions, cancelGate, checkAgainstJsonSchema, defaultResolverRefusal, matchesAllowance, openGate, resolveGate, ruleResolverRefusal, snapshotBrief, snapshotResolver, waitForGate };

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
/** Which check let a resolver past the default refusal: an owner class, else the first widening that applied. */
type GateAdmittedBy = "owner-class" | "allowance" | "evidence" | "delegate";
/** What the store knows about how it admitted the resolver, handed to `authorize` as a third argument. */
interface GateAdmission {
    admittedBy: GateAdmittedBy;
}
/**
 * Runs after the default resolver-class check, so it can refuse a resolver but
 * never admit one the default refused. Must return synchronously. The optional
 * `admission` only informs a refusal; a two-argument authorizer is unaffected.
 */
type GateAuthorize = (gate: Readonly<GateRecord>, resolver: Readonly<GateResolver>, admission?: Readonly<GateAdmission>) => GateAuthorization;
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

export { GateResolverRefused as A, BaseGateStore as B, GateRuleInvalid as C, type GateStatus as D, GateStoreSchemaOutdated as E, type GateRecord as G, type JsonSchema as J, type GateQuestion as a, type GateRule as b, type GateStore as c, type GateResolver as d, type GateEvidence as e, type GateAuthorize as f, type GateAnswerAllowance as g, type GateEvidencePolicy as h, GateAborted as i, type GateAdmission as j, type GateAdmittedBy as k, GateAlreadyExists as l, GateAlreadySettled as m, type GateAuthorization as n, GateAuthorizeInvalid as o, type GateBrief as p, GateBriefInvalid as q, GateCancelled as r, GateError as s, GateEvidenceInvalid as t, GateExpired as u, GateExpiryInvalid as v, type GateInput as w, GateNotFound as x, GatePayloadInvalid as y, type GateQuestionOption as z };
