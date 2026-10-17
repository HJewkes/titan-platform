import { AuthorityRequest, PolicyTable, ActorClass } from '@titan-design/authority';
import { GateBrief, GateRule, GateResolver, GateRecord, GateStore } from '@titan-design/hitl';
import { ZodType } from 'zod';
import { Db, Migration } from '@titan-design/store-sqlite';
import { AgentRunConfig, AgentRunDeps, Harness, HarnessRunRequestFor, DurableHarnessDispatcher } from '@titan-design/agent';
import { ExecutionRecord } from '@titan-design/agent-protocol';
import { TraceRecord } from '@titan-design/agent-protocol/trace';

type WorkflowStatus = "running" | "paused" | "cancelling" | "recovery_required" | "completed" | "failed" | "cancelled";
interface WorkflowOwnerFence {
    runtimeId: string;
    generation: number;
}
interface WorkflowOwnerLease extends WorkflowOwnerFence {
    leaseUntil: string;
}
/** What one step cost, as the runner reported it. */
interface StepUsage {
    costUsd: number;
    inputTokens?: number;
    outputTokens?: number;
    /** Some spend had no price, so `costUsd` is a floor; a budget must refuse it rather than read the gap as free. */
    costUnknown?: true;
}
/** Which context method recorded a result; replay compares it to catch a workflow edited under a live run. */
type StepOperation = "seed" | "dispatch" | "assisted" | "authorize";
interface StepResult<TData extends Record<string, unknown> = Record<string, unknown>> {
    stepId: string;
    iteration: number;
    /** Absent on results written before 0.5, which replay under the old keys unchecked. */
    operation?: StepOperation;
    /** Runner-assigned id (an agent session id, a job id); null for seed and gate steps. */
    agentId: string | null;
    /** Condition signal parsed from the output, e.g. `needs_revision`. */
    signal: string | null;
    completedAt: string;
    output?: string;
    /** Structured payload: a seed's data, a gate's resolution, or a dispatch's output parsed by its schema. */
    data?: TData;
    /** Summed over every attempt, retries included, when the runner reported cost; `mapItems` sums it against its budget. */
    usage?: StepUsage;
    /** The dispatch attempt that produced this result, so a trace can name it; absent reads as 0. */
    attempt?: number;
}
interface ActiveStepBase {
    stepId: string;
    iterKey: string;
    attempt: number;
    startedAt: string;
    /** When this step's first attempt started, kept across retries and restarts; absent on older rows, read `startedAt`. */
    firstStartedAt?: string;
    /** How many restarts re-dispatched this step; they raise `attempt` but spend no retry budget. Absent reads as 0. */
    restarts?: number;
    runnerRef?: string;
    /** Summed cost of this step's earlier failed attempts, so a resumed run still reports every attempt once. */
    priorUsage?: StepUsage;
    recovery?: {
        kind: "legacy_unrecoverable" | "not_found" | "ownership_lost" | "unknown";
        evidence: string;
        observedAt: string;
    };
}
interface LegacyActiveStep extends ActiveStepBase {
    kind: "legacy";
}
interface RecoverableActiveStep extends ActiveStepBase {
    kind: "recoverable";
    executionId: string;
    requestKey: string;
}
type ActiveStep = LegacyActiveStep | RecoverableActiveStep;
interface WorkflowRun {
    id: string;
    workflowName: string;
    /** The registered definition version the run started under; absent means unpinned. */
    definitionVersion?: string;
    /** Workflow parameters plus anything seed steps merged in. */
    params: Record<string, string>;
    status: WorkflowStatus;
    currentStep: string | null;
    /** Keyed by step id and call index: `stepId:n` for dispatches, `stepId` then `stepId:n` for seeds and gates. */
    stepResults: Record<string, StepResult>;
    activeSteps: Record<string, ActiveStep>;
    revision: number;
    ownerGeneration: number;
    owner?: WorkflowOwnerLease;
    startedAt: string;
    completedAt: string | null;
    error: string | null;
}
interface SeedResult {
    /** Merged into the run's params so later prompts can use it. */
    data: Record<string, string>;
    output?: string;
}
interface DispatchOptions<T = Record<string, unknown>> {
    model?: string;
    /** Extra template variables for this step only. */
    vars?: Record<string, string>;
    /** Parses the output as JSON into `data`; a payload that fails it fails the step without a retry. */
    schema?: ZodType<T>;
}
interface AssistedOptions {
    /** Validates the resolution payload; stored as JSON Schema on the gate. */
    schema?: ZodType;
    expiresAt?: Date | string;
    /**
     * Record a cancel of the gate as the step's answer instead of throwing `GateCancelled`: the result's signal is
     * `GATE_CANCELLED_SIGNAL` and its data carries the cancel `reason`, so the next call opens a fresh gate.
     */
    recordCancel?: boolean;
    /** What the owner reads instead of the prompt; a store with `requireBrief` refuses the gate without one. */
    brief?: GateBrief;
    /** Binds the gate to an authority rule, so only that rule's resolver classes (and delegates) may answer it. */
    rule?: GateRule;
}
/** The signal of an `assisted` result whose gate was cancelled under `recordCancel`. */
declare const GATE_CANCELLED_SIGNAL = "gate-cancelled";
/** An authority request without the actor, which the runtime supplies; `tainted` defaults to false. */
type AuthorizeRequest = Omit<AuthorityRequest, "actor" | "tainted"> & {
    tainted?: boolean;
};
interface AuthorizeOptions {
    /** Shown to the owner when the table gates the action. */
    prompt?: string;
    expiresAt?: Date | string;
    /** What the owner reads instead of the prompt; a store with `requireBrief` refuses the gate without one. */
    brief?: GateBrief;
}
/** `allow` came straight from the table; `approved` means an owner answered the rule's gate. */
interface AuthorizeResult {
    verdict: "allow" | "approved";
    ruleId: string;
    gateId?: string;
    resolvedBy?: GateResolver;
}
/** What a workflow function sees. Every method is memoized, so the function is safe to re-run from the top. */
interface WorkflowContext {
    readonly runId: string;
    readonly workflowName: string;
    param(key: string): string | undefined;
    /** Render the template, run it through the step runner, parse signals. Retried once on a retryable failure. */
    dispatch<T extends Record<string, unknown> = Record<string, unknown>>(stepId: string, template: string, options?: DispatchOptions<T>): Promise<StepResult<T>>;
    /** Deterministic step without a runner; its data merges into params. */
    seed(stepId: string, fn: () => Promise<SeedResult>): Promise<StepResult>;
    /** Pause on a durable gate until something outside resolves it. */
    assisted(stepId: string, prompt: string, options?: AssistedOptions): Promise<StepResult>;
    /** Ask the authority table: proceed on allow, wait on a rule-bound gate, throw `AuthorityDeniedError` on deny. */
    authorize(stepId: string, request: AuthorizeRequest, options?: AuthorizeOptions): Promise<AuthorizeResult>;
    /** Cancels this run's own pending gates that `isStale` picks, so no one can answer a question the run has moved past; returns their ids. */
    expireGates(reason: string, isStale: (gate: Readonly<GateRecord>) => boolean): string[];
    /** How many times `stepId` has completed so far; loop guards read this. */
    iteration(stepId: string): number;
    /**
     * While the call just made was answered from the record, the step id the record holds next, so a workflow whose code
     * changed since the record can follow the path the run already took; undefined once the run is live.
     */
    historyNext(): string | undefined;
    /**
     * The step a resumed run was paused on and has not reached again: its gate is still pending, and no row records it
     * until it is answered. Undefined for a live run, or once replay has reached that step.
     */
    resumedGate(): string | undefined;
    /** Steps the previous host left in flight that this drive's replay has not reached yet; the record holds no result for them. */
    recoveredInFlight(): string[];
    /** Aborts when the run is cancelled; pass it to anything long-running. */
    readonly signal: AbortSignal;
}
type WorkflowFn = (ctx: WorkflowContext) => Promise<void>;
interface StepRunInput {
    runId: string;
    workflowName: string;
    stepId: string;
    iteration: number;
    prompt: string;
    model?: string;
    /** The step's schema; a runner may pass it to the model, and the workflow parses the output with it either way. */
    outputSchema?: ZodType;
    signal: AbortSignal;
}
type DurableStepOutcome = {
    kind: "succeeded";
    output: string;
    usage?: StepUsage;
} | {
    kind: "failed";
    error: string;
    retryable: boolean;
    code?: "schema_invalid";
    usage?: StepUsage;
} | {
    kind: "cancelled";
    reason: string;
} | {
    kind: "cancellation_unknown";
    reason: string;
};
interface RecoverableStepDispatchInput extends StepRunInput {
    executionId: string;
    requestKey: string;
    attempt: number;
    /** When the step's first attempt started, so a wait resumed after a restart can keep its original deadline. */
    firstStartedAt: string;
    restarts: number;
}
interface StepDispatchAck {
    executionId: string;
    requestKey: string;
    runnerRef: string;
    completion: Promise<DurableStepOutcome>;
}
type StepReconcileOutcome = {
    kind: "running";
    runnerRef: string;
    completion: Promise<DurableStepOutcome>;
    evidence: string;
} | {
    kind: "terminal";
    outcome: DurableStepOutcome;
    evidence: string;
} | {
    kind: "not_found";
    retrySafe: boolean;
    evidence: string;
} | {
    kind: "ownership_lost";
    evidence: string;
} | {
    kind: "unknown";
    evidence: string;
};
type StepRunOutcome = {
    ok: true;
    output: string;
    runnerRef?: string;
    usage?: StepUsage;
} | {
    ok: false;
    error: string;
    retryable: boolean;
    code?: "schema_invalid";
    usage?: StepUsage;
};
/** Where dispatched steps actually execute: an in-process agent, a queue, a subprocess. */
interface LegacyStepRunner {
    run(input: StepRunInput): Promise<StepRunOutcome>;
    /** @deprecated Prefer RecoverableStepRunner. Undefined or failed attachment requires recovery. */
    attach?(step: ActiveStep, signal: AbortSignal): Promise<StepRunOutcome> | undefined;
}
interface RecoverableStepRunner {
    dispatch(input: RecoverableStepDispatchInput): Promise<StepDispatchAck>;
    reconcile(step: RecoverableActiveStep, signal: AbortSignal): Promise<StepReconcileOutcome>;
}
type StepRunner = LegacyStepRunner | RecoverableStepRunner;
declare function workflowStepRequestKey(runId: string, stepId: string, iteration: number, attempt: number): string;
type WorkflowEvent = {
    type: "step_started";
    runId: string;
    stepId: string;
    iteration: number;
} | {
    type: "step_complete";
    runId: string;
    stepId: string;
    iteration: number;
    signal: string | null;
} | {
    type: "step_retry";
    runId: string;
    stepId: string;
    attempt: number;
    error: string;
} | {
    type: "step_failed";
    runId: string;
    stepId: string;
    error: string;
} | {
    type: "step_abandoned";
    runId: string;
    stepId: string;
    reason: string;
} | {
    type: "workflow_recovery_required";
    runId: string;
    stepId: string;
    evidence: string;
    gateId?: string;
} | {
    type: "gate_opened";
    runId: string;
    stepId: string;
    gateId: string;
    prompt: string;
    summary?: string;
} | {
    type: "workflow_complete";
    runId: string;
} | {
    type: "workflow_failed";
    runId: string;
    error: string;
} | {
    type: "workflow_cancelled";
    runId: string;
    reason: string;
};
interface StepFailureDetail {
    /** The last attempt's failure could clear on a fresh call; `false` means repeating it would fail the same way. */
    retryable?: boolean;
    /** Cost of every failed attempt, when the runner reported it. */
    usage?: StepUsage;
}
declare class StepFailedError extends Error {
    readonly stepId: string;
    readonly iteration: number;
    readonly reason: string;
    readonly retryable: boolean;
    readonly usage: StepUsage | undefined;
    constructor(stepId: string, iteration: number, reason: string, detail?: StepFailureDetail);
}
type StepOutputFailureKind = "not_json" | "schema" | "too_large";
/** A dispatch whose output failed its schema. Never retryable: the same prompt would produce the same kind of payload. */
declare class StepOutputInvalidError extends StepFailedError {
    readonly kind: StepOutputFailureKind;
    readonly issues: string[];
    constructor(stepId: string, iteration: number, kind: StepOutputFailureKind, issues: string[], usage?: StepUsage);
}
/** The authority table denied the action; no gate was opened, and repeating the request is denied the same way. */
declare class AuthorityDeniedError extends StepFailedError {
    readonly ruleId: string | null;
    readonly denial: string;
    constructor(stepId: string, iteration: number, ruleId: string | null, denial: string);
}
/** The rule's gate settled without a valid approval: the owner refused, or the answer's resolver fails the rule. */
declare class AuthorityRefusedError extends StepFailedError {
    readonly ruleId: string;
    readonly gateId: string;
    readonly refusal: string;
    constructor(stepId: string, iteration: number, ruleId: string, gateId: string, refusal: string);
}
declare class WorkflowCancelledError extends Error {
    readonly runId: string;
    readonly reason: string;
    constructor(runId: string, reason: string);
}
/** `cancel` found no run this runtime holds or may claim: another live runtime leases it, or it does not exist. */
declare class WorkflowNotOwnedError extends Error {
    readonly runId: string;
    constructor(runId: string);
}
declare class WorkflowRecoveryRequiredError extends Error {
    readonly runId: string;
    readonly stepId: string;
    readonly evidence: string;
    constructor(runId: string, stepId: string, evidence: string);
}
declare class WorkflowNonDeterminismError extends Error {
    readonly runId: string;
    readonly stepId: string;
    readonly callIndex: number;
    readonly recorded: StepOperation;
    readonly replayed: StepOperation;
    constructor(runId: string, stepId: string, callIndex: number, recorded: StepOperation, replayed: StepOperation);
}
/** A replayed dispatch whose recorded output no longer satisfies the step's current schema. */
declare class WorkflowSchemaDriftError extends Error {
    readonly runId: string;
    readonly stepId: string;
    readonly callIndex: number;
    readonly issues: string[];
    constructor(runId: string, stepId: string, callIndex: number, issues: string[]);
}

type SignalMatcher = (output: string) => boolean;
/** Reported for empty or whitespace-only output, so silence escalates to a human and never reads as approval. */
declare const EMPTY_OUTPUT_SIGNAL = "empty_output";
/**
 * Verdict conventions brain's review and planning prompts converged on. They
 * are a fallback for prose; a canonical marker always wins. Key order is the
 * precedence order, and it is part of the contract: a caller's own record
 * decides its own precedence, and spreading these defaults keeps theirs.
 * `high_risk` escalates to a human, so it outranks every verdict, and a risk
 * score of 4 or more beats a PASS.
 */
declare const DEFAULT_SIGNAL_PATTERNS: Record<string, SignalMatcher>;
/** The highest-precedence signal, or null when nothing matches. */
type SignalParser = (output: string | undefined) => string | null;
/** Every signal the output carries, highest precedence first. */
type SignalSetParser = (output: string | undefined) => string[];
/**
 * Empty output yields only `EMPTY_OUTPUT_SIGNAL`. Otherwise canonical markers
 * naming a known pattern are authoritative and the prose is ignored; without
 * one, every matching prose pattern is reported. Both lists follow the key
 * order of `patterns`. Unknown marker names fall through to the prose.
 */
declare function createSignalSetParser(patterns?: Record<string, SignalMatcher>): SignalSetParser;
/** The first entry of `createSignalSetParser(patterns)`, so the same precedence decides. */
declare function createSignalParser(patterns?: Record<string, SignalMatcher>): SignalParser;
declare const parseSignals: SignalSetParser;
declare const parseSignal: SignalParser;

type TemplateRenderer = (template: string, vars: Record<string, string>) => Promise<string> | string;
/**
 * The variables every step prompt can use: the run's params (as given and as
 * SNAKE_CASE), the workflow identity, and every completed step's output as
 * `STEP_OUTPUT_<STEP>` plus a combined `PREVIOUS_STEP_OUTPUTS` digest.
 */
declare function buildStepVars(run: {
    id: string;
    workflowName: string;
    params: Record<string, string>;
    stepResults: Record<string, StepResult>;
}, extra?: Record<string, string>): Record<string, string>;
/** `{{NAME}}` substitution; unknown names are left in place so a missing variable is visible in the prompt. */
declare const mustacheRenderer: TemplateRenderer;
/** Read from the template, not the rendered prompt, so a `{{NAME}}` inside a substituted value never counts as unfilled. */
declare function unfilledVariables(template: string, vars: Record<string, string>): string[];

declare const DEFAULT_RUN_TABLE = "workflow_run";
declare function workflowRunTableDdl(name?: string): string;
/** Creates a fresh table. Existing deployments also add workflowOwnershipMigration once. */
declare function workflowMigration(version: number, name?: string): Migration;
/** Adds fencing columns when an earlier workflowMigration already created the table. */
declare function workflowOwnershipMigration(version: number, name?: string): Migration;
/** Adds the run's pinned definition version when an earlier workflowMigration already created the table. */
declare function workflowDefinitionVersionMigration(version: number, name?: string): Migration;
/** A pinned run cannot be stored in a table that would silently drop its pin. */
declare class WorkflowStoreSchemaOutdated extends Error {
    readonly table: string;
    constructor(table: string);
}
declare class WorkflowOwnershipLostError extends Error {
    readonly runId: string;
    constructor(runId: string);
}
/** Durable workflow rows with independent runtime ownership and revision fencing. */
declare class WorkflowRunStore {
    private readonly db;
    private readonly name;
    private readonly table;
    constructor(db: Db, name?: string);
    create(run: WorkflowRun): void;
    get(id: string): WorkflowRun | undefined;
    listByStatus(statuses: readonly WorkflowStatus[]): WorkflowRun[];
    /** Counts from the status index alone: a caller that only needs totals never loads or parses a run's step results. */
    countByStatus<S extends WorkflowStatus>(statuses: readonly S[]): Map<S, number>;
    claim(id: string, runtimeId: string, leaseUntil: string, at: string): WorkflowRun | undefined;
    save(run: WorkflowRun, fence: WorkflowOwnerFence, leaseUntil: string, at: string): void;
    renew(run: WorkflowRun, fence: WorkflowOwnerFence, leaseUntil: string, at: string): void;
    /**
     * Adds a result under `key` to a run that already finished, for a fact learnt after it ended; no runtime owns such a
     * run, so no fence applies. False when the run is unfinished or already has that key, so a repeat never rewrites one.
     */
    annotate(id: string, key: string, result: StepResult): boolean;
    /** Every run's status by id, read without a run's step results, so a caller can pick the few runs it must load. */
    statuses(): Map<string, WorkflowStatus>;
    /**
     * Up to `limit` runs of `statuses` with ids after `after`, in id order, finished at or after `completedSince` when
     * given; a caller reads a long history a page at a time instead of holding every run at once.
     */
    page(statuses: readonly WorkflowStatus[], { after, limit, completedSince }: {
        after?: string;
        limit: number;
        completedSince?: string;
    }): WorkflowRun[];
    release(run: WorkflowRun, fence: WorkflowOwnerFence): void;
}

interface AgentRunnerOptions {
    cwd: string;
    maxTurns: number;
    maxBudgetUsd: number;
    /** Everything else `runAgent` accepts, applied to every step; the step's own `model` wins. */
    defaults?: Partial<Omit<AgentRunConfig<unknown>, "prompt" | "cwd" | "maxTurns" | "maxBudgetUsd" | "signal">>;
    deps?: AgentRunDeps;
}
/**
 * Run each step as one headless Claude Code session through
 * `@titan-design/agent`. In-process, so a restart cannot re-attach; hydrate
 * marks interrupted steps recovery_required without redispatching them.
 */
declare function agentRunner(options: AgentRunnerOptions): LegacyStepRunner;
/**
 * Make a live runner recoverable for steps that are safe to repeat, such as
 * read-only judgements. After a restart, an interrupted step is dispatched
 * again instead of parking the run as recovery_required. The step's
 * `agentId` becomes the request key, because the ack must name it before the
 * live runner has reported its own reference.
 */
declare function idempotentRunner(live: LegacyStepRunner): RecoverableStepRunner;
/** Run steps with a plain function. For tests and for workflows whose steps are not agents. */
declare function inlineRunner(fn: (input: StepRunInput) => Promise<string> | string): LegacyStepRunner;

/** `repeat` re-dispatches a step interrupted by a crash; `park` leaves the run recovery_required for a human. */
type RestartRule = "repeat" | "park";
/** What a route's runner receives: the runtime's own input, plus the attempt and request key that name this try. */
interface RoutedStepInput extends StepRunInput {
    attempt: number;
    requestKey: string;
    /**
     * When the step's first attempt started; a restart keeps it, so a wait can resume its deadline. The runtime always
     * sets it and `restarts`; they are optional so an input built by hand, as in a route's own test, still type-checks.
     */
    firstStartedAt?: string;
    /** How many restarts re-dispatched this step; 0 on a first run and on ordinary retries. */
    restarts?: number;
}
interface RouteRunner {
    run(input: RoutedStepInput): Promise<StepRunOutcome>;
}
interface StepRoute {
    /** A step id, which also covers that id's `<id>:<suffix>` family; the longest matching route wins. */
    match: string;
    runner: RouteRunner;
    onRestart: RestartRule;
    /** Decides a step a restart interrupted, ahead of `onRestart`; a rejection parks the run. */
    reconcile?(step: RecoverableActiveStep, signal: AbortSignal): Promise<StepReconcileOutcome>;
}
interface RoutedRunner extends RecoverableStepRunner {
    routeFor(stepId: string): StepRoute | undefined;
    /** Throws naming every step id in `stepIds` that no route covers; call it when registering `workflowName`. */
    assertRoutes(workflowName: string, stepIds: readonly string[]): void;
}
/** One runner for the runtime; each dispatch step goes to the runner and restart rule its route names. */
declare function routedRunner(routes: readonly StepRoute[]): RoutedRunner;

interface MapOptions<T> {
    /** Stable identity per item. Resume matches finished items by key, so reordering the input is safe. */
    key: (item: T) => string;
    /** Items in flight at once. Defaults to 1. */
    concurrency?: number;
    /**
     * Stop launching items once finished items have spent this much. In-flight
     * items are not counted, so a run can overshoot by up to `concurrency - 1` items.
     * An item whose usage is `costUnknown` also stops launches, with `stoppedBy: "cost_unknown"`.
     */
    budgetUsd?: number;
    /** Retryable item failures tolerated before launches stop. Defaults to 3. A non-retryable failure always stops launches. */
    maxFailures?: number;
}
/** Runs one item. Pass `itemStepId` to `ctx.dispatch` so each item memoizes on its own. */
type MapItemFn<T> = (item: T, itemStepId: string, ctx: WorkflowContext) => Promise<StepResult>;
interface MapItemResult<T> {
    key: string;
    item: T;
    result: StepResult;
}
interface MapItemFailure<T> {
    key: string;
    item: T;
    error: string;
    retryable: boolean;
    /** Cost of the item's failed attempts, when the runner reported it; already counted in `spentUsd`. */
    usage?: StepUsage;
}
interface MapResult<T> {
    /** In input order. */
    results: MapItemResult<T>[];
    failed: MapItemFailure<T>[];
    /** Items never launched because the budget ran out or failures stopped the run. */
    skipped: {
        key: string;
        item: T;
    }[];
    /** Cost reported by finished and failed items. */
    spentUsd: number;
    /** `cost_unknown`: with `budgetUsd` set, an item reported unpriced usage, so spend can no longer be checked. */
    stoppedBy: "budget" | "failure" | "cost_unknown" | null;
}
/**
 * Run `fn` over `items` with a concurrency cap and a budget cap. Each item runs
 * as step `${stepId}/${key}`, so a replay after restart reuses finished items
 * and runs only the rest. A `StepFailedError` is recorded in `failed`; a
 * non-retryable one, or one past `maxFailures`, stops new launches. Any other
 * error is rethrown once in-flight items settle.
 */
declare function mapItems<T>(ctx: WorkflowContext, stepId: string, items: readonly T[], fn: MapItemFn<T>, options: MapOptions<T>): Promise<MapResult<T>>;

interface WorkflowAuthorityOptions {
    /** Defaults to the authority package's `DEFAULT_TABLE`. */
    table?: PolicyTable;
    /** Who this runtime acts as in every `ctx.authorize` request. */
    actor: {
        class: ActorClass;
        id: string;
    };
}
interface WorkflowStartOptions {
    /** Runs synchronously inside the transaction that inserts the run, on the runtime's `db`; a throw rolls the run back. */
    onStart?: (runId: string) => void;
}
interface WorkflowRuntimeOptions {
    db: Db;
    gates: GateStore;
    runner: StepRunner;
    render?: TemplateRenderer;
    parseSignal?: SignalParser;
    onEvent?: (event: WorkflowEvent) => void;
    maxRetries?: number;
    gatePollMs?: number;
    /** Largest serialised `data` a schema dispatch may store. Defaults to 64 KiB. */
    maxStepDataBytes?: number;
    runTable?: string;
    runtimeId?: string;
    leaseMs?: number;
    reconcileTimeoutMs?: number;
    now?: () => number;
    executionId?: () => string;
    /** Required by `ctx.authorize`; a run without it fails at its first authorize step. */
    authority?: WorkflowAuthorityOptions;
}

/** The `StepResult.data` key the F3 trace projection reads gate-decision records from. */
declare const TRACE_GATES_KEY = "titan.trace.gates";
/** The `StepResult.data` key the F3 trace projection reads artifact records (commits, PRs, files) from. */
declare const TRACE_ARTIFACTS_KEY = "titan.trace.artifacts";
/** The name every authorize gate records as its rule's table. */
declare const AUTHORITY_TABLE_NAME = "F5";

/**
 * Asked, when a workflow returns, about each recovered step its replay never reached: true drops the step with a
 * `step_abandoned` event, false parks the run. A registration without one parks on every such orphan.
 */
type AbandonsOrphan = (stepId: string) => boolean;

/** Durable workflow driver with fenced row ownership and explicit execution reconciliation. */
declare class WorkflowRuntime {
    private readonly options;
    private readonly workflows;
    private readonly live;
    private readonly held;
    private readonly store;
    private readonly runtimeId;
    private readonly leaseMs;
    private readonly reconcileTimeoutMs;
    private readonly now;
    private readonly baseDeps;
    private isQuiesced;
    constructor(options: WorkflowRuntimeOptions);
    /** `version` pins new runs to this definition (hydrate parks a run pinned to another); `strictReplay` parks a replay that goes live with recorded results unread. */
    register(name: string, fn: WorkflowFn, options?: {
        version?: string;
        abandonsOrphan?: AbandonsOrphan;
        strictReplay?: boolean;
    }): void;
    registered(): string[];
    /** `options.onStart` commits with the run row, or its throw rolls the run back; a quiesced runtime leaves the row unclaimed for its successor. */
    start(name: string, params?: Record<string, string>, options?: WorkflowStartOptions): string;
    /** `exclude` leaves those runs unclaimed this call, for a caller that is not yet sure they are its to drive. */
    hydrate(options?: {
        exclude?: ReadonlySet<string>;
    }): Promise<string[]>;
    private hydrateOne;
    private reconcile;
    private markRecovery;
    private launch;
    private drive;
    private finishFromSuccess;
    private settleRejection;
    shutdown(): void;
    /** Stops admission for a planned handoff: live runs are released and new ones are left for the successor to drive. */
    quiesce(): void;
    quiesced(): boolean;
    private finish;
    status(runId: string): WorkflowRun | undefined;
    list(statuses?: readonly WorkflowRun["status"][]): WorkflowRun[];
    wait(runId: string): Promise<WorkflowRun>;
    /** Resolves the waiting gate as `resolvedBy`; a store that refuses the resolver throws and the run stays paused. */
    signal(runId: string, stepId: string, payload: Record<string, unknown>, resolvedBy: GateResolver): void;
    /** `abandon` finishes a run no runtime drives at once, dropping its in-flight steps unsettled: for a replay that cannot reach them. */
    cancel(runId: string, reason: string, options?: {
        abandon?: boolean;
    }): void;
    /** Records `data` as step `stepId` of a finished run, a fact learnt after it ended; false when the run is unfinished or already has it. */
    annotate(runId: string, stepId: string, data: Record<string, unknown>): boolean;
    /**
     * Records `output` as the answer of a run's active dispatch step, so the run's replay reads it instead of dispatching
     * the step again. Only a run no runtime holds can be answered this way; false when the run is held or has no such step.
     */
    completeStep(runId: string, stepId: string, output: string): boolean;
    private cancelGates;
    private startRenewal;
    private claim;
    private save;
    private release;
    private dropLive;
    private park;
    private parkHydrationFailure;
    private parkPersistenceFailure;
    private leaseWindow;
    private isoNow;
}

interface DurableHarnessRunnerOptions<H extends Harness> {
    /** Supplies native configuration and bounds. The workflow owns the cancellation signal. */
    request(input: RecoverableStepDispatchInput): HarnessRunRequestFor<H, string>;
}
/** Connects the harness-neutral workflow handshake to an authoritative execution ledger. */
declare function durableHarnessRunner<H extends Harness>(dispatcher: DurableHarnessDispatcher<H>, options: DurableHarnessRunnerOptions<H>): RecoverableStepRunner;

declare function gateIdFor(runId: string, stepId: string): string;

/** What a projection reads besides the run; structural, so workflow takes no runtime dependency on the ledger package. */
interface RunTraceSources {
    gates: Pick<GateStore, "get">;
    executions?: {
        findByRequestKey(requestKey: string): ExecutionRecord | undefined;
    };
    /** Hex sha256 of the text; injected so the projection stays pure. */
    digest(text: string): string;
}
/**
 * Projects a stored run into strict trace records: the run first, then each recorded step's attempts, gates and
 * artifacts in recording order, then in-flight steps and the gate a paused run waits on.
 */
declare function projectRunTrace(run: WorkflowRun, sources: RunTraceSources): TraceRecord[];

export { AUTHORITY_TABLE_NAME, type ActiveStep, type AgentRunnerOptions, type AssistedOptions, AuthorityDeniedError, AuthorityRefusedError, type AuthorizeOptions, type AuthorizeRequest, type AuthorizeResult, DEFAULT_RUN_TABLE, DEFAULT_SIGNAL_PATTERNS, type DispatchOptions, type DurableHarnessRunnerOptions, type DurableStepOutcome, EMPTY_OUTPUT_SIGNAL, GATE_CANCELLED_SIGNAL, type LegacyActiveStep, type LegacyStepRunner, type MapItemFailure, type MapItemFn, type MapItemResult, type MapOptions, type MapResult, type RecoverableActiveStep, type RecoverableStepDispatchInput, type RecoverableStepRunner, type RestartRule, type RouteRunner, type RoutedRunner, type RoutedStepInput, type RunTraceSources, type SeedResult, type SignalMatcher, type SignalParser, type SignalSetParser, type StepDispatchAck, StepFailedError, type StepFailureDetail, type StepOperation, type StepOutputFailureKind, StepOutputInvalidError, type StepReconcileOutcome, type StepResult, type StepRoute, type StepRunInput, type StepRunOutcome, type StepRunner, type StepUsage, TRACE_ARTIFACTS_KEY, TRACE_GATES_KEY, type TemplateRenderer, type WorkflowAuthorityOptions, WorkflowCancelledError, type WorkflowContext, type WorkflowEvent, type WorkflowFn, WorkflowNonDeterminismError, WorkflowNotOwnedError, type WorkflowOwnerFence, type WorkflowOwnerLease, WorkflowOwnershipLostError, WorkflowRecoveryRequiredError, type WorkflowRun, WorkflowRunStore, WorkflowRuntime, type WorkflowRuntimeOptions, WorkflowSchemaDriftError, type WorkflowStartOptions, type WorkflowStatus, WorkflowStoreSchemaOutdated, agentRunner, buildStepVars, createSignalParser, createSignalSetParser, durableHarnessRunner, gateIdFor, idempotentRunner, inlineRunner, mapItems, mustacheRenderer, parseSignal, parseSignals, projectRunTrace, routedRunner, unfilledVariables, workflowDefinitionVersionMigration, workflowMigration, workflowOwnershipMigration, workflowRunTableDdl, workflowStepRequestKey };
