import { WorkflowContext, RestartRule } from '@titan-design/workflow';
import { z } from 'zod';

/**
 * The autoresearch recipe: pin, baseline, then rounds of plan, select and a pipelined ladder per idea,
 * with the strongest winner moving the ratchet. Everything outside the run goes through `ArPorts`.
 *
 * Inspired by Andrej Karpathy's autoresearch, https://github.com/karpathy/autoresearch (MIT); no code copied.
 */

declare const AUTORESEARCH_WORKFLOW = "autoresearch";
/** The workflow function; a host registers it under `AUTORESEARCH_WORKFLOW` with routes for every dispatch step. */
declare function runAutoresearch(ctx: WorkflowContext): Promise<void>;

declare const AR_DISPATCH_STEPS: readonly ["pin", "eval", "plan", "alloc", "implement", "l0", "l1", "ratchet", "release"];
type ArDispatchStep = (typeof AR_DISPATCH_STEPS)[number];
/** Pure decisions recorded so a replay reads them back instead of recomputing: the queue, the draws, each idea's stop. */
declare const AR_SEED_STEPS: readonly ["queue", "select", "stop"];
type ArSeedStep = (typeof AR_SEED_STEPS)[number];
/** A step family and the context call that runs it; a host that guards step kinds reads this. */
interface ArStepDeclaration {
    id: string;
    kind: "dispatch" | "seed";
}
declare const arStepId: (name: ArDispatchStep | ArSeedStep) => string;
declare const AUTORESEARCH_STEPS: readonly ArStepDeclaration[];

/** What the planner proposes; the workflow derives `id`, `lineage` and `cell` from it. */
declare const ProposalSchema: z.ZodObject<{
    hypothesis: z.ZodString;
    mechanism: z.ZodString;
    class: z.ZodString;
    direction: z.ZodString;
    targets: z.ZodArray<z.ZodString>;
    params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    expectedEffect: z.ZodObject<{
        metric: z.ZodString;
        direction: z.ZodEnum<{
            up: "up";
            down: "down";
        }>;
        microSignal: z.ZodString;
    }, z.core.$strip>;
    testPlan: z.ZodString;
    bold: z.ZodBoolean;
    differsFrom: z.ZodOptional<z.ZodString>;
    priority: z.ZodDefault<z.ZodNumber>;
    source: z.ZodDefault<z.ZodEnum<{
        planner: "planner";
        owner: "owner";
        requeue: "requeue";
        followup: "followup";
    }>>;
    parent: z.ZodOptional<z.ZodString>;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
type Proposal = z.infer<typeof ProposalSchema>;
declare const IdeaSchema: z.ZodObject<{
    hypothesis: z.ZodString;
    mechanism: z.ZodString;
    class: z.ZodString;
    direction: z.ZodString;
    targets: z.ZodArray<z.ZodString>;
    params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    expectedEffect: z.ZodObject<{
        metric: z.ZodString;
        direction: z.ZodEnum<{
            up: "up";
            down: "down";
        }>;
        microSignal: z.ZodString;
    }, z.core.$strip>;
    testPlan: z.ZodString;
    bold: z.ZodBoolean;
    differsFrom: z.ZodOptional<z.ZodString>;
    priority: z.ZodDefault<z.ZodNumber>;
    source: z.ZodDefault<z.ZodEnum<{
        planner: "planner";
        owner: "owner";
        requeue: "requeue";
        followup: "followup";
    }>>;
    parent: z.ZodOptional<z.ZodString>;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    id: z.ZodString;
    lineage: z.ZodString;
    cell: z.ZodString;
    round: z.ZodNumber;
}, z.core.$strip>;
type Idea = z.infer<typeof IdeaSchema>;
declare const QueueOpsSchema: z.ZodObject<{
    add: z.ZodDefault<z.ZodArray<z.ZodObject<{
        hypothesis: z.ZodString;
        mechanism: z.ZodString;
        class: z.ZodString;
        direction: z.ZodString;
        targets: z.ZodArray<z.ZodString>;
        params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        expectedEffect: z.ZodObject<{
            metric: z.ZodString;
            direction: z.ZodEnum<{
                up: "up";
                down: "down";
            }>;
            microSignal: z.ZodString;
        }, z.core.$strip>;
        testPlan: z.ZodString;
        bold: z.ZodBoolean;
        differsFrom: z.ZodOptional<z.ZodString>;
        priority: z.ZodDefault<z.ZodNumber>;
        source: z.ZodDefault<z.ZodEnum<{
            planner: "planner";
            owner: "owner";
            requeue: "requeue";
            followup: "followup";
        }>>;
        parent: z.ZodOptional<z.ZodString>;
        evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    drop: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    reprioritize: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        priority: z.ZodNumber;
    }, z.core.$strip>>>;
    analysis: z.ZodDefault<z.ZodArray<z.ZodString>>;
    exempt: z.ZodDefault<z.ZodObject<{
        bold: z.ZodOptional<z.ZodString>;
        followup: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type QueueOps = z.infer<typeof QueueOpsSchema>;
/** One evaluator run, as the target's frozen scorer prints it. Every name is the target's own vocabulary. */
declare const ArResultSchema: z.ZodObject<{
    schema: z.ZodLiteral<"ar-result/v2">;
    case: z.ZodString;
    repeat: z.ZodString;
    metrics: z.ZodRecord<z.ZodString, z.ZodNumber>;
    gates: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    violations: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    usd: z.ZodNumber;
    wall_s: z.ZodNumber;
}, z.core.$strip>;
type ArResult = z.infer<typeof ArResultSchema>;
declare const ArMicroSchema: z.ZodObject<{
    schema: z.ZodLiteral<"ar-micro/v1">;
    rung: z.ZodString;
    predicted_direction_met: z.ZodBoolean;
    usd: z.ZodNumber;
}, z.core.$strip>;
type ArMicro = z.infer<typeof ArMicroSchema>;
declare const DiffSizeSchema: z.ZodObject<{
    files: z.ZodNumber;
    lines: z.ZodNumber;
}, z.core.$strip>;
type DiffSize = z.infer<typeof DiffSizeSchema>;
/** How one idea's ladder ended; every stop is recorded, never thrown, so siblings keep running. */
declare const OutcomeSchema: z.ZodObject<{
    ideaId: z.ZodString;
    lineage: z.ZodString;
    cell: z.ZodString;
    verdict: z.ZodEnum<{
        kept: "kept";
        rejected: "rejected";
        stopped: "stopped";
    }>;
    reason: z.ZodString;
    rungReached: z.ZodEnum<{
        none: "none";
        L0: "L0";
        L1: "L1";
        L2: "L2";
        L3: "L3";
    }>;
    head: z.ZodOptional<z.ZodString>;
    branch: z.ZodOptional<z.ZodString>;
    delta: z.ZodOptional<z.ZodNumber>;
    sigma: z.ZodOptional<z.ZodNumber>;
    runs: z.ZodDefault<z.ZodArray<z.ZodObject<{
        schema: z.ZodLiteral<"ar-result/v2">;
        case: z.ZodString;
        repeat: z.ZodString;
        metrics: z.ZodRecord<z.ZodString, z.ZodNumber>;
        gates: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
        violations: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        usd: z.ZodNumber;
        wall_s: z.ZodNumber;
    }, z.core.$strip>>>;
    diff: z.ZodOptional<z.ZodObject<{
        files: z.ZodNumber;
        lines: z.ZodNumber;
    }, z.core.$strip>>;
    lesson: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type Outcome = z.infer<typeof OutcomeSchema>;
declare function ideaId(proposal: Pick<Proposal, "class" | "targets" | "params" | "mechanism">): string;
/** The keep rule as data: which metric is judged, which may not get worse, and which counts must stay zero. */
declare const MetricSpecSchema: z.ZodObject<{
    primary: z.ZodObject<{
        name: z.ZodString;
        direction: z.ZodEnum<{
            min: "min";
            max: "max";
        }>;
    }, z.core.$strip>;
    guards: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    zeroTolerance: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allGate: z.ZodDefault<z.ZodBoolean>;
    noOp: z.ZodOptional<z.ZodString>;
    noise: z.ZodObject<{
        bandSigmas: z.ZodDefault<z.ZodNumber>;
        lockAfterPairs: z.ZodDefault<z.ZodNumber>;
        minPairs: z.ZodDefault<z.ZodNumber>;
        defaultBand: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>;
}, z.core.$strip>;
type MetricSpec = z.infer<typeof MetricSpecSchema>;
/** The subset of `ar-target/v1` the recipe reads; the rung commands belong to the ports. */
declare const TargetSchema: z.ZodObject<{
    schema: z.ZodLiteral<"ar-target/v1">;
    ratchetPrefix: z.ZodString;
    metric: z.ZodObject<{
        primary: z.ZodObject<{
            name: z.ZodString;
            direction: z.ZodEnum<{
                min: "min";
                max: "max";
            }>;
        }, z.core.$strip>;
        guards: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        zeroTolerance: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allGate: z.ZodDefault<z.ZodBoolean>;
        noOp: z.ZodOptional<z.ZodString>;
        noise: z.ZodObject<{
            bandSigmas: z.ZodDefault<z.ZodNumber>;
            lockAfterPairs: z.ZodDefault<z.ZodNumber>;
            minPairs: z.ZodDefault<z.ZodNumber>;
            defaultBand: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>;
    }, z.core.$strip>;
    microRung: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    phases: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        train: z.ZodArray<z.ZodString>;
        baselineRuns: z.ZodDefault<z.ZodNumber>;
        stop: z.ZodObject<{
            ideasEvaluated: z.ZodNumber;
            roundsWithoutGain: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type Target = z.infer<typeof TargetSchema>;
/** A result schema that also requires every metric the keep rule reads, so a run missing one fails its eval step. */
declare function resultSchemaFor(metric: MetricSpec): z.ZodType<ArResult>;

declare const REGISTRY_TAIL = 40;
/** A cell, targets and direction that already failed past L0, so a repeat must say how it differs. */
interface DeadEnd {
    cell: string;
    targets: string[];
    rungFailed: string;
    deltaOverSigma?: number;
    lesson?: string;
}
/** "Fails here, do this instead", from L0 failures and planner analysis. */
interface Bug {
    symptom: string;
    fix: string;
    source: "L0" | "planner";
}
interface Registries {
    deadEnds: DeadEnd[];
    bugs: Bug[];
}
declare const EMPTY_REGISTRIES: Registries;
declare function inDeadEnd(idea: Pick<Idea, "cell" | "targets">, deadEnds: readonly DeadEnd[]): boolean;
declare function recordOutcome(registries: Registries, idea: Idea, outcome: Outcome): Registries;
declare function recordAnalysis(registries: Registries, analysis: readonly string[]): Registries;
/** The tails every implementer brief and planner digest carry, capped so the brief stays bounded. */
declare function registryTails(registries: Registries): Registries;

/** One row of the typed append-only evidence log. Validator rows exist for the owner's report only. */
interface EvidenceRow {
    round: number;
    ideaId: string;
    cell: string;
    rung: Outcome["rungReached"];
    verdict: "positive" | "neutral" | "negative";
    reason: string;
    delta?: number;
    deltaOverSigma?: number;
    usd: number;
    diff?: DiffSize;
    lesson?: string;
    source: "training" | "validator";
}
interface CellRow {
    cell: string;
    trials: number;
    meanAbsDeltaOverSigma: number;
    keepRate: number;
    flag?: "explore" | "demote";
}
interface Digest {
    round: number;
    evidence: EvidenceRow[];
    cells: CellRow[];
    registries: Registries;
    queue: Pick<Idea, "id" | "cell" | "class" | "mechanism" | "priority" | "bold">[];
}
declare function evidenceRow(round: number, outcome: Outcome): EvidenceRow;
/** What the planner reads each round. Validator results never enter it: a look that steered the search would leak. */
declare function buildDigest(input: {
    round: number;
    evidence: readonly EvidenceRow[];
    registries: Registries;
    queue: readonly Idea[];
}): Digest;
/** Stable prefix first and the idea last, so sibling lanes in a round share every byte up to the registries. */
declare function implementerBrief(digest: Digest, idea: Idea): string;

declare const PinnedSchema: z.ZodObject<{
    pin: z.ZodString;
    ratchetRef: z.ZodString;
    ratchetHead: z.ZodString;
    integrationTree: z.ZodString;
    target: z.ZodObject<{
        schema: z.ZodLiteral<"ar-target/v1">;
        ratchetPrefix: z.ZodString;
        metric: z.ZodObject<{
            primary: z.ZodObject<{
                name: z.ZodString;
                direction: z.ZodEnum<{
                    min: "min";
                    max: "max";
                }>;
            }, z.core.$strip>;
            guards: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
            zeroTolerance: z.ZodDefault<z.ZodArray<z.ZodString>>;
            allGate: z.ZodDefault<z.ZodBoolean>;
            noOp: z.ZodOptional<z.ZodString>;
            noise: z.ZodObject<{
                bandSigmas: z.ZodDefault<z.ZodNumber>;
                lockAfterPairs: z.ZodDefault<z.ZodNumber>;
                minPairs: z.ZodDefault<z.ZodNumber>;
                defaultBand: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>;
        }, z.core.$strip>;
        microRung: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        phases: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            train: z.ZodArray<z.ZodString>;
            baselineRuns: z.ZodDefault<z.ZodNumber>;
            stop: z.ZodObject<{
                ideasEvaluated: z.ZodNumber;
                roundsWithoutGain: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    bounds: z.ZodObject<{
        schema: z.ZodLiteral<"ar-bounds/v1">;
        classes: z.ZodRecord<z.ZodString, z.ZodObject<{
            paths: z.ZodArray<z.ZodString>;
            tests: z.ZodDefault<z.ZodArray<z.ZodString>>;
            params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
type Pinned = z.infer<typeof PinnedSchema>;
declare const TreeSchema: z.ZodObject<{
    tree: z.ZodString;
    branch: z.ZodString;
}, z.core.$strip>;
declare const ImplementedSchema: z.ZodObject<{
    head: z.ZodString;
    usd: z.ZodNumber;
    lesson: z.ZodOptional<z.ZodString>;
    diff: z.ZodOptional<z.ZodObject<{
        files: z.ZodNumber;
        lines: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const StaticCheckSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    code: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const HeadSchema: z.ZodObject<{
    head: z.ZodString;
}, z.core.$strip>;
declare const ReleasedSchema: z.ZodObject<{
    released: z.ZodString;
}, z.core.$strip>;
interface RatchetRequest {
    tree: string;
    ratchetRef: string;
    ratchetPrefix: string;
    from: string;
    to: string;
}
/** Everything the loop touches outside its own run, so tests inject fakes and no test calls a model. */
interface ArPorts {
    /** Reads `target.json` and `bounds.json` at the pin and points the ratchet ref at the run's starting head. */
    pin(input: {
        runId: string;
        pin: string;
    }, signal: AbortSignal): Promise<Pinned>;
    /** The central planner's queue ops for one round; the workflow checks them against the schema and quotas. */
    plan(input: {
        runId: string;
        round: number;
        digest: Digest;
        violations: string[];
    }, signal: AbortSignal): Promise<unknown>;
    allocTree(input: {
        runId: string;
        ideaId: string;
        base: string;
    }, signal: AbortSignal): Promise<z.infer<typeof TreeSchema>>;
    implement(input: {
        idea: Idea;
        tree: string;
        base: string;
        brief: string;
    }, signal: AbortSignal): Promise<z.infer<typeof ImplementedSchema>>;
    /** L0: bounds post-check, unit suite and test proof; never a model call. */
    staticCheck(input: {
        idea: Idea;
        tree: string;
        base: string;
        head: string;
    }, signal: AbortSignal): Promise<z.infer<typeof StaticCheckSchema>>;
    micro(input: {
        idea: Idea;
        tree: string;
        rung: string;
    }, signal: AbortSignal): Promise<ArMicro>;
    evalCase(input: {
        tree: string;
        case: string;
        key: string;
    }, signal: AbortSignal): Promise<ArResult>;
    ratchet(input: RatchetRequest, signal: AbortSignal): Promise<{
        head: string;
    }>;
    /** Parks the tree: checkout removed, branch kept. */
    releaseTree(input: {
        tree: string;
    }, signal: AbortSignal): Promise<void>;
    now(): number;
}

/** One dispatch step's port call; a host wraps it in a route and answers with its result under `result`. */
interface ArStepHandler {
    name: ArDispatchStep;
    onRestart: RestartRule;
    /** Checks the step's JSON input against its schema, then calls the port. */
    run(input: unknown, signal: AbortSignal): Promise<object>;
}
/**
 * Every step but the ratchet only reads, or writes inside its own idea tree, so a restart repeats it.
 * A ratchet push cut off mid-way may have moved the remote, so a person decides.
 */
declare function arStepHandlers(ports: ArPorts): ArStepHandler[];

declare const BoundsSchema: z.ZodObject<{
    schema: z.ZodLiteral<"ar-bounds/v1">;
    classes: z.ZodRecord<z.ZodString, z.ZodObject<{
        paths: z.ZodArray<z.ZodString>;
        tests: z.ZodDefault<z.ZodArray<z.ZodString>>;
        params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type Bounds = z.infer<typeof BoundsSchema>;
/** `ar-bounds-pre`, run on every planner add before any spawn: a failure costs nothing but the planner's words. */
declare function preCheck(proposal: Proposal, bounds: Bounds, caseNames: readonly string[]): string | undefined;

/** The target's metric spec; noise settings are read by the band, not by the rule. */
type KeepSettings = Omit<MetricSpec, "noise">;
interface Band {
    /** Already `bandSigmas`·σ, in primary-metric units. */
    width: number;
    sigma: number;
}
type KeepDecision = {
    decision: "accept" | "confirm" | "reject";
    reason: string;
    delta: number;
};
declare function median(values: readonly number[]): number;
/** Positive is better, whichever way the metric points. */
declare function improvement(best: readonly ArResult[], idea: readonly ArResult[], settings: KeepSettings): number;
/** The first zero-tolerance violation any one of `runs` carries. */
declare function zeroToleranceHit(runs: readonly ArResult[], settings: KeepSettings): string | undefined;
/** The keep rule (plan 5.1) on one training case: accept, ask for confirm runs, or reject. */
declare function keepRule(best: readonly ArResult[], idea: readonly ArResult[], band: Band, settings: KeepSettings): KeepDecision;
/** Both confirm runs must beat the best's median on their own; one loss rejects. */
declare function confirmRule(best: readonly ArResult[], confirms: readonly ArResult[], settings: KeepSettings): KeepDecision;

interface NoiseSettings {
    bandSigmas: number;
    /** σ stops moving once this many pairs are in, so later heads are judged against a fixed band. */
    lockAfterPairs: number;
    /** Below this many pairs σ is not trusted and the band is the default. */
    minPairs: number;
    defaultBand: number;
}
/** Two runs of the same code on the same case. */
interface Pair {
    a: number;
    b: number;
}
interface NoiseState {
    pairs: Pair[];
    locked?: number;
}
declare const NO_NOISE: NoiseState;
/** Pooled within-pair sd, `sqrt(Σ d² / 2n)`: differences between code versions never inflate it. */
declare function pooledSigma(pairs: readonly Pair[]): number | undefined;
declare function addPair(state: NoiseState, pair: Pair, settings: NoiseSettings): NoiseState;
declare function sigmaOf(state: NoiseState): number | undefined;
/** The keep band in primary-metric units: `bandSigmas`·σ once σ is trusted, never below the default until it locks. */
declare function band(state: NoiseState, settings: NoiseSettings): number;

interface Arm {
    alpha: number;
    beta: number;
}
interface Draw {
    id: string;
    draw: number;
}
interface Selection {
    picks: Idea[];
    draws: Draw[];
    /** The planner's own top K by priority, logged beside the pick to test whether sampling earns its keep. */
    plannerTopK: string[];
}
declare function reward(outcome: Outcome): number;
/** mulberry32: small, fast, and the same sequence for the same seed on every host. */
declare function seededRandom(seed: string): () => number;
declare function betaDraw(arm: Arm, random: () => number): number;
/** Thompson sampling over lineages; the seed is `runId:round`, so a replayed round picks the same ideas. */
declare function select(queue: readonly Idea[], outcomes: readonly Outcome[], options: {
    runId: string;
    round: number;
    k: number;
}): Selection;

interface QueueContext {
    round: number;
    bounds: Bounds;
    caseNames: readonly string[];
    deadEnds: readonly DeadEnd[];
    /** Every idea id already queued or evaluated, so an exact repeat is refused. */
    seen: ReadonlySet<string>;
    /** Lineage of every idea id seen, so a follow-up or requeue inherits its parent's. */
    lineageOf: ReadonlyMap<string, string>;
}
interface QuotaContext {
    /** Ideas kept last round; each one owes a follow-up. */
    keptLastRound: readonly string[];
    minPool: number;
    queuedBefore: number;
}
interface Applied {
    queue: Idea[];
    rejected: {
        proposal: Proposal;
        code: string;
    }[];
}
declare function toIdea(proposal: Proposal, context: Pick<QueueContext, "round" | "lineageOf">): Idea;
/** Quotas the planner must meet each round (plan 4.2); an empty list means the ops may be applied. */
declare function quotaViolations(ops: QueueOps, quota: QuotaContext): string[];
/** Applies the planner's ops mechanically: adds pass dedup, the bounds pre-check and the dead-end rule, at no model cost. */
declare function applyOps(queue: readonly Idea[], ops: QueueOps, context: QueueContext): Applied;

export { AUTORESEARCH_STEPS, AUTORESEARCH_WORKFLOW, type ArDispatchStep, type ArMicro, ArMicroSchema, type ArPorts, type ArResult, ArResultSchema, type ArStepDeclaration, type ArStepHandler, type Band, type Bounds, BoundsSchema, type DeadEnd, type DiffSize, DiffSizeSchema, type Digest, EMPTY_REGISTRIES, type EvidenceRow, HeadSchema, type Idea, IdeaSchema, ImplementedSchema, type KeepSettings, type MetricSpec, MetricSpecSchema, NO_NOISE, type NoiseSettings, type NoiseState, type Outcome, OutcomeSchema, type Pinned, PinnedSchema, type Proposal, type QueueOps, QueueOpsSchema, REGISTRY_TAIL, type RatchetRequest, type Registries, ReleasedSchema, StaticCheckSchema, type Target, TargetSchema, TreeSchema, addPair, applyOps, arStepHandlers, arStepId, band, betaDraw, buildDigest, confirmRule, evidenceRow, ideaId, implementerBrief, improvement, inDeadEnd, keepRule, median, pooledSigma, preCheck, quotaViolations, recordAnalysis, recordOutcome, registryTails, resultSchemaFor, reward, runAutoresearch, seededRandom, select, sigmaOf, toIdea, zeroToleranceHit };
