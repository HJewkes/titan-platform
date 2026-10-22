import { WorkflowContext, RestartRule, WorkflowStatus, WorkflowRun } from '@titan-design/workflow';
import { z } from 'zod';

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
    microArgs: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
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
    microArgs: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
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
        microArgs: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
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
    rung: z.ZodOptional<z.ZodString>;
    evaluator_pin: z.ZodOptional<z.ZodString>;
    artifact_dir: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type ArResult = z.infer<typeof ArResultSchema>;
declare const ArMicroSchema: z.ZodObject<{
    schema: z.ZodLiteral<"ar-micro/v1">;
    rung: z.ZodString;
    predicted_direction_met: z.ZodBoolean;
    usd: z.ZodNumber;
    signal: z.ZodOptional<z.ZodString>;
    base: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    idea: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
}, z.core.$strip>;
type ArMicro = z.infer<typeof ArMicroSchema>;
/** `files` and `lines` count the whole diff; the `src` and `test` splits are measured by L0, never self-reported. */
declare const DiffSizeSchema: z.ZodObject<{
    files: z.ZodNumber;
    lines: z.ZodNumber;
    srcFiles: z.ZodOptional<z.ZodNumber>;
    srcLines: z.ZodOptional<z.ZodNumber>;
    testLines: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
type DiffSize = z.infer<typeof DiffSizeSchema>;
/** The noise an idea was judged against, fixed at round start; `locked` is the engine's own call, not a pair count. */
declare const AgainstSchema: z.ZodObject<{
    case: z.ZodString;
    head: z.ZodString;
    bandWidth: z.ZodNumber;
    sigma: z.ZodNumber;
    pairs: z.ZodNumber;
    locked: z.ZodBoolean;
}, z.core.$strip>;
/** The agent that wrote the idea; `account` names whose spend it was. */
declare const ImplementerSchema: z.ZodObject<{
    agent: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    resumedFrom: z.ZodOptional<z.ZodString>;
    mode: z.ZodEnum<{
        spawn: "spawn";
        resume: "resume";
    }>;
    account: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
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
        rung: z.ZodOptional<z.ZodString>;
        evaluator_pin: z.ZodOptional<z.ZodString>;
        artifact_dir: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    diff: z.ZodOptional<z.ZodObject<{
        files: z.ZodNumber;
        lines: z.ZodNumber;
        srcFiles: z.ZodOptional<z.ZodNumber>;
        srcLines: z.ZodOptional<z.ZodNumber>;
        testLines: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    lesson: z.ZodOptional<z.ZodString>;
    against: z.ZodOptional<z.ZodObject<{
        case: z.ZodString;
        head: z.ZodString;
        bandWidth: z.ZodNumber;
        sigma: z.ZodNumber;
        pairs: z.ZodNumber;
        locked: z.ZodBoolean;
    }, z.core.$strip>>;
    implementer: z.ZodOptional<z.ZodObject<{
        agent: z.ZodString;
        sessionId: z.ZodOptional<z.ZodString>;
        resumedFrom: z.ZodOptional<z.ZodString>;
        mode: z.ZodEnum<{
            spawn: "spawn";
            resume: "resume";
        }>;
        account: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    lane: z.ZodOptional<z.ZodNumber>;
    fork: z.ZodOptional<z.ZodEnum<{
        exploit: "exploit";
        explore: "explore";
    }>>;
    l0: z.ZodOptional<z.ZodObject<{
        ok: z.ZodBoolean;
        code: z.ZodOptional<z.ZodString>;
        checks: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            ok: z.ZodBoolean;
            code: z.ZodOptional<z.ZodString>;
            ms: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    micro: z.ZodOptional<z.ZodObject<{
        schema: z.ZodLiteral<"ar-micro/v1">;
        rung: z.ZodString;
        predicted_direction_met: z.ZodBoolean;
        usd: z.ZodNumber;
        signal: z.ZodOptional<z.ZodString>;
        base: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        idea: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    }, z.core.$strip>>;
    usage: z.ZodOptional<z.ZodObject<{
        implementUsd: z.ZodNumber;
        evalUsd: z.ZodNumber;
        microUsd: z.ZodNumber;
    }, z.core.$strip>>;
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
    guards: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodNumber, z.ZodObject<{
        slack: z.ZodNumber;
        direction: z.ZodEnum<{
            min: "min";
            max: "max";
        }>;
    }, z.core.$strip>]>>>;
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
/** The subset of `ar-target/v1` the recipe and the ports read. */
declare const TargetSchema: z.ZodObject<{
    schema: z.ZodLiteral<"ar-target/v1">;
    repo: z.ZodOptional<z.ZodString>;
    ratchetPrefix: z.ZodString;
    metric: z.ZodObject<{
        primary: z.ZodObject<{
            name: z.ZodString;
            direction: z.ZodEnum<{
                min: "min";
                max: "max";
            }>;
        }, z.core.$strip>;
        guards: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodNumber, z.ZodObject<{
            slack: z.ZodNumber;
            direction: z.ZodEnum<{
                min: "min";
                max: "max";
            }>;
        }, z.core.$strip>]>>>;
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
    frozen: z.ZodDefault<z.ZodArray<z.ZodString>>;
    caseSets: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    runnerRoot: z.ZodDefault<z.ZodString>;
    unitTests: z.ZodDefault<z.ZodArray<z.ZodString>>;
    testProof: z.ZodDefault<z.ZodArray<z.ZodString>>;
    rungs: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        cmd: z.ZodArray<z.ZodString>;
        maxUsd: z.ZodOptional<z.ZodNumber>;
        timeoutMin: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
    phases: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        train: z.ZodArray<z.ZodString>;
        baselineRuns: z.ZodDefault<z.ZodNumber>;
        stop: z.ZodObject<{
            ideasEvaluated: z.ZodNumber;
            roundsWithoutGain: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    validator: z.ZodDefault<z.ZodObject<{
        runs: z.ZodDefault<z.ZodNumber>;
        maxLooks: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type Target = z.infer<typeof TargetSchema>;
/** Fills each `{name}` token of an argv template; a token with no value throws, so a rung never runs with a literal brace. */
declare function renderCommand(cmd: readonly string[], vars: Readonly<Record<string, string>>): string[];
/** The micro rung's `<count>:<up|down>` argument: a planner signal that already names its direction is kept as it is. */
declare function microSignalArg(idea: Pick<Proposal, "expectedEffect">): string;
/** A result schema that also requires every metric the keep rule reads, the gates of an allGate target and each zero-tolerance violation count, so a run missing one fails its eval step. */
declare function resultSchemaFor(metric: MetricSpec): z.ZodType<ArResult>;

declare const REGISTRY_TAIL = 40;
/** A cell, targets and direction that already failed past L0, so a repeat must say how it differs. */
interface DeadEnd {
    ideaId: string;
    round: number;
    cell: string;
    targets: string[];
    rungFailed: string;
    deltaOverSigma?: number;
    lesson?: string;
}
/** "Fails here, do this instead", from L0 failures and planner analysis. */
interface Bug {
    /** Absent on a planner's analysis line, which names no single idea. */
    ideaId?: string;
    round: number;
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
declare function recordOutcome(registries: Registries, idea: Idea, outcome: Outcome, round: number): Registries;
declare function recordAnalysis(registries: Registries, analysis: readonly string[], round: number): Registries;
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
declare function cellTable(rows: readonly EvidenceRow[]): CellRow[];
/** What the planner reads each round. Validator results never enter it: a look that steered the search would leak. */
declare function buildDigest(input: {
    round: number;
    evidence: readonly EvidenceRow[];
    registries: Registries;
    queue: readonly Idea[];
}): Digest;
/** Stable prefix first and the idea last, so sibling lanes in a round share every byte up to the registries. */
declare function implementerBrief(digest: Digest, idea: Idea): string;

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

declare const PinnedSchema: z.ZodObject<{
    pin: z.ZodString;
    ratchetRef: z.ZodString;
    ratchetHead: z.ZodString;
    integrationTree: z.ZodString;
    target: z.ZodObject<{
        schema: z.ZodLiteral<"ar-target/v1">;
        repo: z.ZodOptional<z.ZodString>;
        ratchetPrefix: z.ZodString;
        metric: z.ZodObject<{
            primary: z.ZodObject<{
                name: z.ZodString;
                direction: z.ZodEnum<{
                    min: "min";
                    max: "max";
                }>;
            }, z.core.$strip>;
            guards: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodNumber, z.ZodObject<{
                slack: z.ZodNumber;
                direction: z.ZodEnum<{
                    min: "min";
                    max: "max";
                }>;
            }, z.core.$strip>]>>>;
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
        frozen: z.ZodDefault<z.ZodArray<z.ZodString>>;
        caseSets: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        runnerRoot: z.ZodDefault<z.ZodString>;
        unitTests: z.ZodDefault<z.ZodArray<z.ZodString>>;
        testProof: z.ZodDefault<z.ZodArray<z.ZodString>>;
        rungs: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            cmd: z.ZodArray<z.ZodString>;
            maxUsd: z.ZodOptional<z.ZodNumber>;
            timeoutMin: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>>;
        phases: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            train: z.ZodArray<z.ZodString>;
            baselineRuns: z.ZodDefault<z.ZodNumber>;
            stop: z.ZodObject<{
                ideasEvaluated: z.ZodNumber;
                roundsWithoutGain: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>>;
        validator: z.ZodDefault<z.ZodObject<{
            runs: z.ZodDefault<z.ZodNumber>;
            maxLooks: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    bounds: z.ZodObject<{
        schema: z.ZodLiteral<"ar-bounds/v1">;
        classes: z.ZodRecord<z.ZodString, z.ZodObject<{
            paths: z.ZodArray<z.ZodString>;
            tests: z.ZodDefault<z.ZodArray<z.ZodString>>;
            params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>>;
            integerParams: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
        diff: z.ZodDefault<z.ZodObject<{
            oneClassPerIdea: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>;
        test: z.ZodDefault<z.ZodObject<{
            required: z.ZodDefault<z.ZodBoolean>;
            mustFailOnBase: z.ZodDefault<z.ZodBoolean>;
            exceptClasses: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
        banned: z.ZodDefault<z.ZodObject<{
            frozenTouch: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodObject<{}, z.core.$loose>]>>;
            literalsOutsideConfig: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodObject<{
                allowed: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
            }, z.core.$loose>]>>;
            newFiles: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodObject<{}, z.core.$loose>]>>;
            seedNames: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodObject<{}, z.core.$loose>]>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    evaluatorTree: z.ZodOptional<z.ZodString>;
    frozenHash: z.ZodOptional<z.ZodString>;
    targetSha: z.ZodOptional<z.ZodString>;
    boundsSha: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type Pinned = z.infer<typeof PinnedSchema>;
declare const TreeSchema: z.ZodObject<{
    tree: z.ZodString;
    branch: z.ZodString;
}, z.core.$strip>;
declare const ImplementedSchema: z.ZodObject<{
    agent: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    resumedFrom: z.ZodOptional<z.ZodString>;
    mode: z.ZodEnum<{
        spawn: "spawn";
        resume: "resume";
    }>;
    account: z.ZodOptional<z.ZodString>;
    head: z.ZodString;
    usd: z.ZodNumber;
    lesson: z.ZodOptional<z.ZodString>;
    diff: z.ZodOptional<z.ZodObject<{
        files: z.ZodNumber;
        lines: z.ZodNumber;
        srcFiles: z.ZodOptional<z.ZodNumber>;
        srcLines: z.ZodOptional<z.ZodNumber>;
        testLines: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    usage: z.ZodOptional<z.ZodObject<{
        usd: z.ZodNumber;
        cacheReadTokens: z.ZodOptional<z.ZodNumber>;
        cacheWrite5mTokens: z.ZodOptional<z.ZodNumber>;
        cacheWrite1hTokens: z.ZodOptional<z.ZodNumber>;
        retries: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** The planner that answered a round (G2) and what its turn cost (G4); `ops` is checked against the queue schema later. */
declare const PlannerSchema: z.ZodObject<{
    agent: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    mode: z.ZodOptional<z.ZodEnum<{
        spawn: "spawn";
        resume: "resume";
    }>>;
    usage: z.ZodOptional<z.ZodObject<{
        usd: z.ZodNumber;
        cacheReadTokens: z.ZodOptional<z.ZodNumber>;
        cacheWrite5mTokens: z.ZodOptional<z.ZodNumber>;
        cacheWrite1hTokens: z.ZodOptional<z.ZodNumber>;
        retries: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const PlannedSchema: z.ZodObject<{
    agent: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    mode: z.ZodOptional<z.ZodOptional<z.ZodEnum<{
        spawn: "spawn";
        resume: "resume";
    }>>>;
    usage: z.ZodOptional<z.ZodOptional<z.ZodObject<{
        usd: z.ZodNumber;
        cacheReadTokens: z.ZodOptional<z.ZodNumber>;
        cacheWrite5mTokens: z.ZodOptional<z.ZodNumber>;
        cacheWrite1hTokens: z.ZodOptional<z.ZodNumber>;
        retries: z.ZodNumber;
    }, z.core.$strip>>>;
    ops: z.ZodUnknown;
}, z.core.$strip>;
type Planner = z.infer<typeof PlannerSchema>;
/** One row per L0 check, in the order they ran; `diff` is measured and replaces the implementer's own count on the outcome. */
declare const StaticCheckSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    code: z.ZodOptional<z.ZodString>;
    checks: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        ok: z.ZodBoolean;
        code: z.ZodOptional<z.ZodString>;
        ms: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
    diff: z.ZodOptional<z.ZodObject<{
        files: z.ZodNumber;
        lines: z.ZodNumber;
        srcFiles: z.ZodOptional<z.ZodNumber>;
        srcLines: z.ZodOptional<z.ZodNumber>;
        testLines: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** `load5` is absent when the host has no load gate. */
declare const LoadWaitSchema: z.ZodObject<{
    waitedMs: z.ZodNumber;
    load5: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/** Empty when the host keeps no round archive. */
declare const ArchivedSchema: z.ZodObject<{
    path: z.ZodOptional<z.ZodString>;
    sha256: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const HeadSchema: z.ZodObject<{
    head: z.ZodString;
}, z.core.$strip>;
declare const ReleasedSchema: z.ZodObject<{
    released: z.ZodString;
}, z.core.$strip>;
/**
 * Which run's pin an evaluator step runs under. Recorded by the pin step, so a host that restarted after it rebuilds
 * its evaluator from these and refuses when the frozen files no longer hash to `frozenHash`.
 */
interface RunPin {
    runId: string;
    pin: string;
    frozenHash?: string;
}
interface RatchetRequest extends RunPin {
    tree: string;
    ratchetRef: string;
    ratchetPrefix: string;
    from: string;
    to: string;
    round: number;
    ideaId: string;
    kind: "ff";
    keepRung: string;
    delta: number;
    sigma: number;
    /** sha256 of each kept run's canonical JSON, so the record names the evidence the move rests on. */
    runDigests: string[];
}
type Fork = "exploit" | "explore";
type PlanMode = "spawn" | "resume";
interface ImplementRequest {
    /** A host names its implementers from the run, not from the tree it was handed. */
    runId: string;
    idea: Idea;
    tree: string;
    base: string;
    brief: string;
    round: number;
    /** The lane slot, 1 to `lanes`. */
    lane: number;
    fork: Fork;
    /** An exploit lane resumes this agent, the last winner's implementer. */
    resumeFrom?: string;
}
interface MicroRequest extends RunPin {
    idea: Idea;
    tree: string;
    rung: string;
    case: string;
    /** The best's first run's artifact dir, which a replay rung reads as the before side. */
    baselineDir: string;
    microSignal: string;
    microArgs: Record<string, string>;
    key: string;
}
/** The G11 round record: what the round decided and what it read. */
interface RoundRecord {
    outcomes: Outcome[];
    digest: Digest;
    ops: QueueOps;
    draws: {
        id: string;
        draw: number;
    }[];
    registries: Registries;
    evidence: EvidenceRow[];
    /** Absent when the host's planner reports no agent. */
    planner?: Planner;
}
/** G7 and G16: what a round decided, recorded after its ratchet so a reader never re-derives it. */
declare const RoundSummarySchema: z.ZodObject<{
    round: z.ZodNumber;
    best: z.ZodObject<{
        head: z.ZodString;
        primary: z.ZodNumber;
    }, z.core.$strip>;
    against: z.ZodObject<{
        case: z.ZodString;
        head: z.ZodString;
        bandWidth: z.ZodNumber;
        sigma: z.ZodNumber;
        pairs: z.ZodNumber;
        locked: z.ZodBoolean;
    }, z.core.$strip>;
    keptIds: z.ZodArray<z.ZodString>;
    superseded: z.ZodArray<z.ZodString>;
    ratchet: z.ZodNullable<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
    }, z.core.$strip>>;
    quotaViolations: z.ZodArray<z.ZodString>;
    plannerRetried: z.ZodBoolean;
}, z.core.$strip>;
type RoundSummary = z.infer<typeof RoundSummarySchema>;
declare const StopReasonSchema: z.ZodEnum<{
    "ideas-evaluated": "ideas-evaluated";
    "rounds-without-gain": "rounds-without-gain";
    "rounds-exhausted": "rounds-exhausted";
}>;
type StopReason = z.infer<typeof StopReasonSchema>;
declare const InboxSchema: z.ZodObject<{
    ideas: z.ZodArray<z.ZodObject<{
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
        microArgs: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
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
    }, z.core.$strip>>;
    cursor: z.ZodNumber;
}, z.core.$strip>;
/** G17: one phase's row in the host's registry. Cases appear only as the target's own train aliases. */
declare const RegistryRowSchema: z.ZodObject<{
    phase: z.ZodString;
    pin: z.ZodString;
    targetSha: z.ZodOptional<z.ZodString>;
    boundsSha: z.ZodOptional<z.ZodString>;
    trainCases: z.ZodArray<z.ZodString>;
    ideasByRung: z.ZodRecord<z.ZodString, z.ZodNumber>;
    sigma: z.ZodNumber;
    pairs: z.ZodNumber;
    locked: z.ZodBoolean;
    spend: z.ZodObject<{
        agentUsd: z.ZodNumber;
        modelUsd: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheWriteTokens: z.ZodNumber;
    }, z.core.$strip>;
    archives: z.ZodArray<z.ZodString>;
    stopReason: z.ZodEnum<{
        "ideas-evaluated": "ideas-evaluated";
        "rounds-without-gain": "rounds-without-gain";
        "rounds-exhausted": "rounds-exhausted";
    }>;
    provenance: z.ZodString;
}, z.core.$strip>;
type RegistryRow = z.infer<typeof RegistryRowSchema>;
declare const RegisteredSchema: z.ZodObject<{
    path: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** A validator look returns aggregates only; strict, so a per-case key fails the step instead of reaching a reader. */
declare const LookAggregateSchema: z.ZodObject<{
    look: z.ZodNumber;
    at: z.ZodString;
    sha: z.ZodString;
    aggregate: z.ZodObject<{
        metrics: z.ZodRecord<z.ZodString, z.ZodNumber>;
        gates: z.ZodRecord<z.ZodString, z.ZodNumber>;
    }, z.core.$strict>;
    provenance: z.ZodString;
    usd: z.ZodNumber;
}, z.core.$strict>;
type LookAggregate = z.infer<typeof LookAggregateSchema>;
interface LookRequest {
    /** The run being looked at, not the look's own run. */
    runId: string;
    pin: string;
    frozenHash?: string;
    look: number;
    head: string;
}
/** Everything the loop touches outside its own run, so tests inject fakes and no test calls a model. */
interface ArPorts {
    /** Reads `target.json` and `bounds.json` at the pin and points the ratchet ref at the run's starting head. */
    pin(input: {
        runId: string;
        pin: string;
    }, signal: AbortSignal): Promise<Pinned>;
    /**
     * The central planner's queue ops for one round, which the workflow checks against the schema and quotas, and the
     * agent that wrote them. Round 1 spawns the planner; later rounds resume it.
     */
    plan(input: {
        runId: string;
        round: number;
        digest: Digest;
        violations: string[];
        mode: PlanMode;
    }, signal: AbortSignal): Promise<z.input<typeof PlannedSchema>>;
    allocTree(input: {
        runId: string;
        ideaId: string;
        base: string;
        lane: number;
    }, signal: AbortSignal): Promise<z.infer<typeof TreeSchema>>;
    implement(input: ImplementRequest, signal: AbortSignal): Promise<z.input<typeof ImplementedSchema>>;
    /** L0: bounds post-check, unit suite and test proof; never a model call. */
    staticCheck(input: RunPin & {
        idea: Idea;
        tree: string;
        base: string;
        head: string;
    }, signal: AbortSignal): Promise<z.input<typeof StaticCheckSchema>>;
    micro(input: MicroRequest, signal: AbortSignal): Promise<ArMicro>;
    /** `key` is unique per run, scope and repeat, since a target may use it as a cache directory. */
    evalCase(input: RunPin & {
        tree: string;
        case: string;
        key: string;
        rung: string;
    }, signal: AbortSignal): Promise<ArResult>;
    ratchet(input: RatchetRequest, signal: AbortSignal): Promise<{
        head: string;
    }>;
    /** Parks the tree: checkout removed, branch kept. */
    releaseTree(input: {
        tree: string;
    }, signal: AbortSignal): Promise<void>;
    /**
     * Waits for machine load to fall before a stage starts; a host with no gate omits it and the step answers at once.
     * `firstStartedAt` is when the step first started, kept across a restart, so a deadline does not reset.
     */
    loadWait?(input: {
        stage: string;
        firstStartedAt?: string;
    }, signal: AbortSignal): Promise<z.input<typeof LoadWaitSchema>>;
    /** Writes the round's record and artifacts somewhere durable; a host with no archive omits it. */
    archive?(input: {
        runId: string;
        round: number;
        record: RoundRecord;
    }, signal: AbortSignal): Promise<z.input<typeof ArchivedSchema>>;
    /** Owner proposals written since `after`, and the cursor past them; a host with no inbox omits it. */
    ownerIdeas?(input: {
        runId: string;
        round: number;
        after: number;
    }, signal: AbortSignal): Promise<z.input<typeof InboxSchema>>;
    /** One milestone look at the head on held-out cases, aggregated; the search never reads it. */
    validate?(input: LookRequest, signal: AbortSignal): Promise<LookAggregate>;
    /** Appends the phase's row to the host's registry; a host with none omits it. */
    registry?(input: {
        runId: string;
        row: RegistryRow;
    }, signal: AbortSignal): Promise<z.input<typeof RegisteredSchema>>;
    now(): number;
}

declare const AUTORESEARCH_WORKFLOW = "autoresearch";
/** Plan 4.5: after a KEEP, this many follow-ups of the winner resume its implementer; every `basinEvery`th round all lanes explore. */
declare const ForkScheduleSchema: z.ZodObject<{
    afterKeep: z.ZodDefault<z.ZodObject<{
        exploit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    basinEvery: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
declare const RunSettingsSchema: z.ZodObject<{
    lanes: z.ZodDefault<z.ZodNumber>;
    rounds: z.ZodDefault<z.ZodNumber>;
    minPool: z.ZodDefault<z.ZodNumber>;
    caseNames: z.ZodDefault<z.ZodArray<z.ZodString>>;
    forkSchedule: z.ZodDefault<z.ZodObject<{
        afterKeep: z.ZodDefault<z.ZodObject<{
            exploit: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        basinEvery: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type RunSettings = z.infer<typeof RunSettingsSchema>;
/**
 * The outcomes a round settles on: each superseded winner stopped, every outcome stamped with the round's σ.
 * The recipe and any reader of the recorded stops share it, so they cannot disagree.
 */
declare function finalOutcomes(stops: readonly Outcome[], { sigma, superseded }: {
    sigma: number;
    superseded: readonly string[];
}): Outcome[];
/** The workflow function; a host registers it under `AUTORESEARCH_WORKFLOW` with routes for every dispatch step. */
declare function runAutoresearch(ctx: WorkflowContext): Promise<void>;

declare const AR_DISPATCH_STEPS: readonly ["pin", "eval", "plan", "alloc", "implement", "l0", "l1", "ratchet", "release", "load-wait", "archive", "inbox", "validate", "registry"];
type ArDispatchStep = (typeof AR_DISPATCH_STEPS)[number];
/**
 * Pure decisions recorded so a replay reads them back instead of recomputing: the queue, the draws, each ladder's
 * lane slot and stop, each round's summary and why the loop ended.
 */
declare const AR_SEED_STEPS: readonly ["queue", "select", "lane", "stop", "summary", "end"];
type ArSeedStep = (typeof AR_SEED_STEPS)[number];
/** A step family and the context call that runs it; a host that guards step kinds reads this. */
interface ArStepDeclaration {
    id: string;
    kind: "dispatch" | "seed";
}
declare const arStepId: (name: ArDispatchStep | ArSeedStep) => string;
declare const AUTORESEARCH_STEPS: readonly ArStepDeclaration[];

/**
 * G17: a milestone look at a run's head on held-out cases. It is its own workflow run, so the parent's digest,
 * queue and keep decisions never read it; the host counts looks against `target.validator.maxLooks`.
 */

declare const AUTORESEARCH_VALIDATE_WORKFLOW = "autoresearch-validate";
/** The look runs one step, so a host declares only that one. */
declare const AUTORESEARCH_VALIDATE_STEPS: readonly ArStepDeclaration[];
/** Params `parent`, `pin`, `head`, `look` and an optional `frozenHash`, all from the parent's recorded pin and summary. */
declare function runValidatorLook(ctx: WorkflowContext): Promise<void>;

/** What the runtime knows about this try of the step, which never goes in the step's input, so a replay sees the same input. */
interface StepTiming {
    /** When the step's first attempt started; a restart keeps it. */
    firstStartedAt?: string;
}
/** One dispatch step's port call; a host wraps it in a route and answers with its result under `result`. */
interface ArStepHandler {
    name: ArDispatchStep;
    onRestart: RestartRule;
    /** Checks the step's JSON input against its schema, then calls the port. */
    run(input: unknown, signal: AbortSignal, timing?: StepTiming): Promise<object>;
}
/**
 * Every step but the ratchet only reads, writes inside its own idea tree or rewrites its own round archive, so a restart repeats it;
 * a repeated registry row carries the same run and phase, so a host's reader keeps the last.
 * A ratchet push cut off mid-way may have moved the remote, so a person decides.
 */
declare function arStepHandlers(ports: ArPorts): ArStepHandler[];

declare const BoundsSchema: z.ZodObject<{
    schema: z.ZodLiteral<"ar-bounds/v1">;
    classes: z.ZodRecord<z.ZodString, z.ZodObject<{
        paths: z.ZodArray<z.ZodString>;
        tests: z.ZodDefault<z.ZodArray<z.ZodString>>;
        params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>>;
        integerParams: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    diff: z.ZodDefault<z.ZodObject<{
        oneClassPerIdea: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    test: z.ZodDefault<z.ZodObject<{
        required: z.ZodDefault<z.ZodBoolean>;
        mustFailOnBase: z.ZodDefault<z.ZodBoolean>;
        exceptClasses: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    banned: z.ZodDefault<z.ZodObject<{
        frozenTouch: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodObject<{}, z.core.$loose>]>>;
        literalsOutsideConfig: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodObject<{
            allowed: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
        }, z.core.$loose>]>>;
        newFiles: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodObject<{}, z.core.$loose>]>>;
        seedNames: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodObject<{}, z.core.$loose>]>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type Bounds = z.infer<typeof BoundsSchema>;
/** `ar-bounds-pre`, run on every planner add before any spawn: a failure costs nothing but the planner's words. */
declare function preCheck(proposal: Proposal, bounds: Bounds, caseNames: readonly string[]): string | undefined;

interface DiffFile {
    path: string;
    /** The old path of a rename. */
    from?: string;
    status: "A" | "M" | "D" | "R";
    added: string[];
    removed: number;
}
/** Parses `git diff --no-color --unified=0 -M base head`; pure, so a host and a fixture feed it the same text. */
declare function parseUnifiedDiff(text: string): DiffFile[];

interface CheckRow {
    name: string;
    ok: boolean;
    code?: string;
}
interface PostCheckInput {
    idea: Pick<Idea, "class">;
    diff: readonly DiffFile[];
    bounds: Bounds;
    /** The target's frozen globs: the evaluator and everything it reads. */
    frozen: readonly string[];
    /** The run's case names; the `seedNames` ban says where a host reads them from. */
    caseNames: readonly string[];
    /** `changedParams` over the class's params file, base against head. */
    paramValues?: Record<string, unknown>;
}
interface PostCheck {
    code?: string;
    checks: CheckRow[];
    size: DiffSize;
}
/** `ar-bounds-post` (L0) over a real diff: every check runs and is recorded, and the first failure is the code. */
declare function postCheck(input: PostCheckInput): PostCheck;
/** Dotted keys whose value changed, mapped to the new value; a removed key maps to `null`. */
declare function changedParams(beforeJson: string, afterJson: string): Record<string, unknown>;
/**
 * Class globs an idea could use to edit a frozen path. With no file list only wildcard-free globs are
 * tested; a host with `git ls-files` passes it so glob classes are tested file by file.
 */
declare function frozenOverlap(bounds: Bounds, frozen: readonly string[], files?: readonly string[]): string[];

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

/** An eval run under the console's name for its wall time. */
type ArEvalView = Omit<ArResult, "wall_s"> & {
    wallS: number;
};
interface ArMetricView {
    primary: string;
    direction: MetricSpec["primary"]["direction"];
    guards: string[];
    zeroTolerance: string[];
    /** The gate names the baseline ran when the all-gate rule is on; empty otherwise. */
    allGate: string[];
    noOp: string[];
    noise: {
        bandSigmas: number;
        lockAfterPairs: number;
        minPairs: number;
        defaultBandPp: number;
    };
}
interface ArTargetView {
    name: string;
    pin: string;
    ratchetRef: string;
    metric: ArMetricView;
    phases: string[];
    repo?: string;
    ratchetPrefix: string;
}
type ArIdeaView = Idea & {
    lineageDepth: number;
};
interface ArLadderView {
    idea: ArIdeaView;
    implementer: z.infer<typeof ImplementerSchema> | null;
    active: {
        stepId: string;
        firstStartedAt: string;
        restarts: number;
    } | null;
    completed: {
        stepId: string;
        completedAt: string;
    }[];
    implementUsd: number | null;
    l0: z.infer<typeof StaticCheckSchema> | null;
    micro: (ArMicro & {
        predictedDirectionMet: boolean;
    }) | null;
    evals: ArEvalView[];
    /** The recorded stop, settled by `finalOutcomes` once its round's summary exists; null while the ladder runs. */
    outcome: Outcome | null;
}
interface ArRoundView {
    round: number;
    queue: ArIdeaView[];
    rejected: {
        code: string;
    }[];
    plannerRetried: boolean;
    planner?: Planner;
    exempt: QueueOps["exempt"];
    analysis: string[];
    selection: {
        picks: string[];
        draws: {
            id: string;
            draw: number;
        }[];
        plannerTopK: string[];
    };
    ladders: ArLadderView[];
    ratchet: RoundSummary["ratchet"];
}
interface ArRunView {
    runId: string;
    status: WorkflowStatus;
    startedAt: string;
    completedAt: string | null;
    error: string | null;
    stopReason?: string;
    target: ArTargetView;
    settings: Pick<RunSettings, "lanes" | "rounds" | "minPool">;
    baseline: {
        runs: ArEvalView[];
        b0: number;
    };
    best: RoundSummary["best"];
    rounds: ArRoundView[];
    registries: Registries;
    cells: CellRow[];
    validator?: {
        maxLooks: number;
        looks: LookAggregate[];
    };
}
interface ArRunSummary {
    runId: string;
    target: string;
    phase: string;
    round: number;
    rounds: number;
    status: WorkflowStatus;
    startedAt: string;
    completedAt: string | null;
    /** Null until every baseline eval is recorded. */
    best: RoundSummary["best"] | null;
    spend: number;
}

/**
 * G14: a run's read model, replayed from its recorded steps. It reads the step ids the recipe writes and never
 * re-decides what the recipe recorded; the one shared rule, settling a round's outcomes, is the recipe's own `finalOutcomes`.
 */

/** The console names gates and the no-op metric as lists, and the band in pp; everything else keeps the engine's shape. */
declare function projectMetric(metric: MetricSpec, baseline: readonly ArResult[]): ArMetricView;
/** One row of `autoresearch.runs`; `best` stays null until every baseline eval is recorded. */
declare function arRunSummary(run: WorkflowRun): ArRunSummary;
/**
 * Where an idea's latest ladder forked and what it built, for its diff: the outcome's `against.head`, else the best the
 * round started from. Undefined when the run never picked the idea or its implementer has not answered.
 */
declare function ideaRefs(run: WorkflowRun, ideaId: string): {
    base: string;
    head: string;
} | undefined;
/** The run page's model; null until the pin step has recorded the target. `looks` are the run's validate runs. */
declare function arRunView(run: WorkflowRun, looks?: readonly WorkflowRun[]): ArRunView | null;

export { AUTORESEARCH_STEPS, AUTORESEARCH_VALIDATE_STEPS, AUTORESEARCH_VALIDATE_WORKFLOW, AUTORESEARCH_WORKFLOW, AgainstSchema, type ArDispatchStep, type ArEvalView, type ArIdeaView, type ArLadderView, type ArMetricView, type ArMicro, ArMicroSchema, type ArPorts, type ArResult, ArResultSchema, type ArRoundView, type ArRunSummary, type ArRunView, type ArStepDeclaration, type ArStepHandler, type ArTargetView, ArchivedSchema, type Band, type Bounds, BoundsSchema, type CellRow, type CheckRow, type DeadEnd, type DiffFile, type DiffSize, DiffSizeSchema, type Digest, EMPTY_REGISTRIES, type EvidenceRow, type Fork, ForkScheduleSchema, HeadSchema, type Idea, IdeaSchema, type ImplementRequest, ImplementedSchema, ImplementerSchema, InboxSchema, type KeepSettings, LoadWaitSchema, type LookAggregate, LookAggregateSchema, type LookRequest, type MetricSpec, MetricSpecSchema, type MicroRequest, NO_NOISE, type NoiseSettings, type NoiseState, type Outcome, OutcomeSchema, type Pinned, PinnedSchema, type PlanMode, PlannedSchema, type Planner, PlannerSchema, type PostCheck, type PostCheckInput, type Proposal, ProposalSchema, type QueueOps, QueueOpsSchema, REGISTRY_TAIL, type RatchetRequest, RegisteredSchema, type Registries, type RegistryRow, RegistryRowSchema, ReleasedSchema, type RoundRecord, type RoundSummary, RoundSummarySchema, type RunPin, type RunSettings, RunSettingsSchema, StaticCheckSchema, type StepTiming, type StopReason, StopReasonSchema, type Target, TargetSchema, TreeSchema, addPair, applyOps, arRunSummary, arRunView, arStepHandlers, arStepId, band, betaDraw, buildDigest, cellTable, changedParams, confirmRule, evidenceRow, finalOutcomes, frozenOverlap, ideaId, ideaRefs, implementerBrief, improvement, inDeadEnd, keepRule, median, microSignalArg, parseUnifiedDiff, pooledSigma, postCheck, preCheck, projectMetric, quotaViolations, recordAnalysis, recordOutcome, registryTails, renderCommand, resultSchemaFor, reward, runAutoresearch, runValidatorLook, seededRandom, select, sigmaOf, toIdea, zeroToleranceHit };
