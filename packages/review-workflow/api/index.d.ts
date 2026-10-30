import { ReviewTarget, ReviewRequest, PanelMember, PanelVerdict, ReviewShape, ReviewerAgent, PrFacts, Headroom, ReviewerDispatch, ReviewerReader, ReviewClock, ReviewClass, PrClass, PanelPlan, PanelPolicy, ClassRules, AwaitVerdictResult, MemberResult, AwaitVerdictInput, Malformed } from '@titan-design/review-panel';
import { LineSource } from '@titan-design/evidence';
import { ProofReadInput, ProofStanding } from '@titan-design/fix-proof';
import { PullRequest } from '@titan-design/github';
import { z } from 'zod';

/** One review of one PR head; the ports carry every read and effect, so the input names only what the caller already knows. */
interface ReviewHeadInput {
    /** The host run, so a parked run is found again on its fingerprint's resolve. */
    runId: string;
    target: ReviewTarget;
    /** The registered kind; absent means unread, which takes the strict class. */
    kind?: string;
    /** Everything the member briefs carry except the target. */
    brief: ReviewRequest["brief"];
    /** A member a hold requires on top of the planned panel, such as a G10 hold's adversary. */
    hold?: PanelMember;
}
/**
 * Why one member, or the run, failed to reach a verdict. Each class has exactly one row in the retry policy. `throttled`
 * is a `never-started` or `timeout` while the machine stop held, so it goes to the caller's throttle path and never to the fixer.
 */
declare const FAILURE_CLASSES: readonly ["never-started", "start-refused:profile", "start-refused:headroom", "start-refused:other", "timeout", "throttled", "usage-limit", "malformed", "stale-head", "shortfall", "deterministic-repeat", "schema-drift", "proof-spec-problem", "heal-ineffective"];
type FailureClass = (typeof FAILURE_CLASSES)[number];
/** How one review of one head ended; the workflow pushes nothing, so catching up to main is always the author's lane. */
type ReviewOutcome = {
    kind: "MERGE";
    head: string;
    verdict: PanelVerdict;
} | {
    kind: "FIX_FIRST";
    head: string;
    verdict: PanelVerdict;
}
/** The fix-proof did not reproduce the bug; the author's lane, never counted as FIX_FIRST. */
 | {
    kind: "NO_REPRO";
    head: string;
    waivable: boolean;
}
/** A clean merge-up of `from`, a head the review signed off; no reviewer runs. */
 | {
    kind: "carried";
    head: string;
    from: string;
} | {
    kind: "head-moved";
    head: string;
    current: string;
}
/** Behind the base and merges clean. */
 | {
    kind: "needs-update";
    head: string;
} | {
    kind: "conflict";
    head: string;
} | {
    kind: "account-hold";
    head: string;
    resetsAt?: number;
}
/** Draft, closed or merged: nothing to review. */
 | {
    kind: "not-open";
    head: string;
    state: "draft" | "closed" | "merged";
} | {
    kind: "ci-not-green";
    head: string;
    ci: "pending" | "failing";
}
/** Every failure was transient and its retry budget is spent. */
 | {
    kind: "no-verdict";
    head: string;
    classes: readonly FailureClass[];
}
/** A hard error parked the run until `resolve(fingerprint)`. */
 | {
    kind: "needs-fixer";
    head: string;
    fingerprint: string;
    failure: FailureClass;
}
/** The fix-proof errored on a carried test-support target; the author's lane, with the file named. */
 | {
    kind: "proof-spec-problem";
    head: string;
    file: string;
};
type ReviewOutcomeKind = ReviewOutcome["kind"];
/**
 * The step id each recipe step records under. Shepherd injects its legacy ids so the outcome corpus, which keys on
 * `sh-await-verdict:<head>`, stays continuous.
 */
interface ReviewStepIds {
    preflight: string;
    heal: string;
    fixProof: string;
    intent: string;
    dispatch: string;
    await: string;
    correct: string;
    lateRead: string;
    aggregate: string;
    fixer: string;
}
declare const DEFAULT_REVIEW_STEP_IDS: Readonly<ReviewStepIds>;
/** Names a member's agent; the default is review-panel's `memberName`. */
type MemberNamer = (target: ReviewTarget, shape: ReviewShape, attempt: 1 | 2) => string;

/** What preflight reads about the head in one pass. */
interface HeadSnapshot {
    pr: PullRequest;
    /** The head's required checks, rolled up. */
    ci: "green" | "pending" | "failing";
    facts: PrFacts;
    /** The file list or a line count could not be read, so the head classifies as large. */
    sizeUnread?: boolean;
}
interface SnapshotPort {
    read(target: ReviewTarget): Promise<HeadSnapshot>;
}
/** The read `proofStanding` takes, so the workflow judges a head's proof exactly as every other fix-proof reader does. */
type ProofRead = ProofReadInput;
interface ProofReaderPort {
    read(target: ReviewTarget): Promise<ProofRead>;
}
/** Whether the head is a clean merge-up of a head the review already signed off. */
type CarryProbe = {
    kind: "carries";
    from: string;
} | {
    kind: "no-carry";
};
interface CarryPort {
    probe(target: ReviewTarget): Promise<CarryProbe>;
}
type CheckoutState = {
    kind: "ready";
} | {
    kind: "missing";
} | {
    kind: "wrong-commit";
    at: string;
} | {
    kind: "low-disk";
    freeBytes: number;
    freeInodesPct: number;
};
/** The read-only checkout a reviewer starts in; `refresh` drops it and recreates it at the target head. */
interface CheckoutPort {
    state(target: ReviewTarget): Promise<CheckoutState>;
    refresh(target: ReviewTarget): Promise<void>;
}
/** Fixer names are a pure function of the fingerprint, so the roster alone dedupes a fixer across PRs. */
interface FixerPort {
    roster(): Promise<readonly ReviewerAgent[]>;
    spawn(name: string, brief: string): Promise<void>;
}
/** `account: held` means no account can start a reviewer until `resetsAt`. */
interface HeadroomRead extends Headroom {
    account: "available" | "held";
    resetsAt?: number;
}
interface HeadroomPort {
    read(): Promise<HeadroomRead>;
}
/** Whether an agent profile is installed, so a member whose profile is not is refused before any dispatch (tp#1986). */
interface ProfilesPort {
    installed(profile: string): boolean;
}
interface ReviewWorkflowPorts {
    snapshot: SnapshotPort;
    proofReader: ProofReaderPort;
    carry: CarryPort;
    checkout: CheckoutPort;
    dispatch: ReviewerDispatch;
    reader: ReviewerReader;
    /** Reads cited files at the head, for the aggregate's citation check. */
    source: LineSource;
    fixer: FixerPort;
    clock: ReviewClock;
    headroom: HeadroomPort;
    profiles: ProfilesPort;
    /** Absent means review-panel's `memberName`. */
    namer?: MemberNamer;
}

/** The PR as classification sees it; `sizeUnread` means the file list or a line count could not be read. */
interface PlanFacts {
    facts: PrFacts;
    sizeUnread?: boolean;
}
/** The panel table and role profiles, plus the class rules that size a diff; absent rules are review-panel's defaults. */
interface ReviewPlanPolicy {
    panel: PanelPolicy;
    rules?: ClassRules;
}
/** The profile of the adversary member a hold adds, whatever the panel table says; a `PanelMember` fits. */
interface HoldMember {
    profile: string;
}
interface HeadPlan {
    class: ReviewClass;
    touches: PrClass["touches"];
    plan: PanelPlan;
}
/** The class, touches and panel for one head. The standing decides the tests seat, so it is never re-derived here. Pure. */
declare function planForHead({ facts, sizeUnread }: PlanFacts, policy: ReviewPlanPolicy, standing: ProofStanding, hold?: HoldMember, headroom?: Headroom): HeadPlan;

/** The heals a policy row may name; a heal never pushes to the PR. */
type HealKind = "refresh-checkout" | "degrade-headroom" | "retarget" | "await-account";
/**
 * One same-head attempt kind, taken `times` times in order before the row's `then`. `late-read` reads the member's
 * transcript once more before a fresh member is spawned. `times: null` means the attempt is never counted.
 */
type RetryStep = {
    action: "retry" | "correct" | "late-read";
    times: number;
} | {
    action: "heal";
    heal: HealKind;
    times: number | null;
};
/** The key S7's fixer fingerprint is built from, joined with the class's own detail (a profile name, a shape, a step id). */
type FixerKey = "profile" | "dispatch" | "timeout" | "parser" | "plan-aggregate-mismatch" | "repeat" | "schema" | "heal-ineffective";
/** What follows once a row's steps are spent; there is no owner action (decision 515). */
type RetryTerminal = {
    kind: "fixer";
    key: FixerKey;
} | {
    kind: "stop";
    outcome: "no-verdict" | "NO_REPRO" | "proof-spec-problem";
}
/** Not a failure: the heal resolves it, so nothing follows. */
 | {
    kind: "none";
};
interface RetryRule {
    class: FailureClass;
    steps: readonly RetryStep[];
    then: RetryTerminal;
    /** Takes the place of `then` when a shortfall's missing seat is not the fix-proof's. */
    otherwise?: RetryTerminal;
}
type RetryPolicy = readonly RetryRule[];
/** One row per failure class (plan TP-3916 §(b)); a hill-climbing variant replaces rows, never code. */
declare const DEFAULT_RETRY_POLICY: RetryPolicy;

/** One hard error: the policy row's fixer key plus the class's own detail (a profile name, a shape, a step id). */
interface FixerCase {
    failure: FailureClass;
    key: FixerKey;
    detail?: readonly string[];
}
/** `<key>:<detail>…`, for example `profile:reviewer`; whitespace inside a detail becomes `-`, so it stays one argv word. */
declare function fixerFingerprint(fixerCase: FixerCase): string;
/**
 * A pure function of the fingerprint and how often it was resolved, never of the PR, so a second run with the same
 * fingerprint finds the first fixer's roster row. A run that fails again after a resolve gets a fresh fixer.
 */
declare function fixerName(fingerprint: string, round?: number): string;
/** One review run waiting on a fingerprint's fix. */
interface ParkedRun {
    runId: string;
    target: ReviewTarget;
    fingerprint: string;
    failure: FailureClass;
}
/** Where parked runs wait; the host stores them, so a parked run outlives the process that parked it. */
interface ParkingPort {
    /** Idempotent per `runId`. */
    park(run: ParkedRun): Promise<void>;
    parked(fingerprint: string): Promise<readonly ParkedRun[]>;
    /** Clears every run parked on the fingerprint, advances its round, and returns the runs it cleared. */
    release(fingerprint: string): Promise<readonly ParkedRun[]>;
    /** How many times the fingerprint was released; 0 before its first resolve. */
    round(fingerprint: string): Promise<number>;
}
/**
 * What the fixer may do. Only `propose` exists: it files a task or writes a patch into its report, and the coordinator
 * applies it. An apply mode is a new key here plus its rules (owner question TP-3916 Q1).
 */
type FixerMode = "propose";
interface FixerMember {
    name: string;
    agentId?: string;
    sessionId?: string;
    transcriptPath?: string;
    /** Why the member never started, when its dispatch was refused. */
    refused?: string;
}
/** What the failed attempts left behind; every field is quoted to the fixer as data. */
interface FixerEvidence {
    /** The recorded steps of the failed attempts, one `stepId: summary` line each. */
    steps: readonly string[];
    members: readonly FixerMember[];
    /** The tail of the host's error log; only lines naming a member are quoted. */
    log?: string;
}
interface FixerRequest {
    runId: string;
    target: ReviewTarget;
    fixerCase: FixerCase;
    evidence: FixerEvidence;
    /** The seat the fixer reports to; absent means its spawner. */
    reportTo?: string;
    mode?: FixerMode;
}
/** The record a run keeps under its fixer step: `spawned` is false when the fingerprint's fixer already existed or was refused. */
interface FixerRecord {
    fingerprint: string;
    agent: string;
    spawned: boolean;
    reason?: string;
}
/** Generalizes Shepherd's no-verdict diagnosis brief from one PR to every run parked on one fingerprint. */
declare function fixerBrief(request: FixerRequest, fingerprint: string, parked: readonly ParkedRun[]): string;
/**
 * Parks the run on its fingerprint and spawns that fingerprint's fixer unless the roster already holds it. A refused
 * spawn is recorded, not thrown: the run stays parked and the record's `reason` tells the host.
 */
declare function requestFixer(ports: {
    fixer: FixerPort;
    parking: ParkingPort;
}, request: FixerRequest): Promise<{
    record: FixerRecord;
    outcome: ReviewOutcome;
}>;
type Resumed = {
    run: ParkedRun;
    outcome: ReviewOutcome;
} | {
    run: ParkedRun;
    error: string;
};
/**
 * Re-runs every run parked on the fingerprint, one at a time, once the coordinator has applied the fix. A resume that
 * throws parks its run again, so no run is lost; a run that fails on the same cause parks itself with a fresh fixer.
 */
declare function resolveFingerprint(parking: ParkingPort, fingerprint: string, resume: (run: ParkedRun) => Promise<ReviewOutcome>): Promise<Resumed[]>;

type HealPorts = Pick<ReviewWorkflowPorts, "checkout" | "snapshot" | "headroom">;
/** What a heal acts on: the head under review and, for a headroom refusal, the member the spawn gate refused. */
interface HealSubject {
    target: ReviewTarget;
    member?: PanelMember;
    /** The plan's premium-to-sonnet table; absent means review-panel's `DEFAULT_SONNET_FOR`. */
    sonnetFor?: Record<string, string>;
}
/** The decision shape that asks for heals; every other decision passes through `healOnce` untouched. */
interface HealRequest {
    kind: "heal";
    heals: readonly HealKind[];
}
type HealEffect = {
    kind: "healed";
    subject: HealSubject;
} | {
    kind: "stop";
    outcome: ReviewOutcome;
}
/** The heal has nothing to act on, such as a refused member with no sonnet fallback. */
 | {
    kind: "ineffective";
    heal: HealKind;
};
/** `heals` names what was still asked for after the one pass, or the heal that could not act. */
type HealPassResult<D> = {
    kind: "decided";
    decision: D;
    subject: HealSubject;
} | {
    kind: "stop";
    outcome: ReviewOutcome;
} | {
    kind: "fixer";
    key: "heal-ineffective";
    heals: readonly HealKind[];
};
declare function applyHeal(heal: HealKind, subject: HealSubject, ports: HealPorts): Promise<HealEffect>;
/**
 * Runs the heals a decision asks for, each once and in order, then re-decides once. A heal that cannot act, or a
 * re-decision that still asks for a heal, goes to the fixer: a second pass would repeat a heal that already failed.
 */
declare function healOnce<D extends {
    kind: string;
}>(decision: D | HealRequest, subject: HealSubject, ports: HealPorts, decide: (subject: HealSubject) => Promise<D | HealRequest>): Promise<HealPassResult<D>>;

/** Everything preflight decides on, read in one pass by `preflightRead`; recorded, so a replay decides the same way. */
interface PreflightSnapshot {
    target: ReviewTarget;
    head: HeadSnapshot;
    proof: ProofStanding;
    /** The base the proof judged (TP-4259), kept for a later merge guard; absent when the read names none. */
    proofBase?: string;
    carry: CarryProbe;
    checkout: CheckoutState;
    headroom: HeadroomRead;
    /** Each profile the policy could plan and whether it is installed; a profile left out reads as not installed. */
    profiles: Readonly<Record<string, boolean>>;
    hold?: HoldMember;
}
/** `heal` is the shape `healOnce` consumes; `go` carries the plan the members are dispatched from. */
type PreflightDecision = {
    kind: "go";
    plan: HeadPlan;
} | HealRequest | {
    kind: "stop";
    outcome: ReviewOutcome;
} | {
    kind: "fixer";
    fixerCase: FixerCase;
};
/**
 * The gate before any reviewer starts. Order: not open, head moved, CI not green, a NO_REPRO that ends the review, a carried
 * merge-up, behind or dirty, then the plan and its profiles, then the heals the checkout and account need. Pure.
 */
declare function preflight(snapshot: PreflightSnapshot, policy: ReviewPlanPolicy): PreflightDecision;

interface PreflightReadInput {
    target: ReviewTarget;
    policy: ReviewPlanPolicy;
    hold?: HoldMember;
}
type PreflightPorts = Pick<ReviewWorkflowPorts, "snapshot" | "proofReader" | "carry" | "checkout" | "headroom" | "profiles">;
/** The `preflight-read` step body: one pass over the ports, so `preflight` decides on a recorded snapshot and never reads. */
declare function preflightRead({ target, policy, hold }: PreflightReadInput, ports: PreflightPorts): Promise<PreflightSnapshot>;

declare const FIXER_REPORT_START = "FIXER-REPORT";
declare const FIXER_REPORT_END = "END-FIXER-REPORT";
/** What the fixer proposes; it applies none of them itself (propose-only, plan TP-3916 §(c) phase 1). */
declare const FIXER_FIXES: readonly ["config", "profile-field", "code-task", "none"];
type FixerFix = (typeof FIXER_FIXES)[number];
/** The parsed block. `patch` is set exactly when `fix` is config or profile-field, `task` exactly when it is code-task. */
interface FixerReport {
    fingerprint: string;
    failure: FailureClass;
    rootCause: string;
    evidence: readonly string[];
    fix: FixerFix;
    patch?: string;
    task?: string;
    resolves: boolean;
}
type FixerReportRefusal = "no_block" | "multiple_blocks" | "unknown_line" | "duplicate_field" | "missing_fingerprint" | "missing_root_cause" | "missing_evidence" | "bad_class" | "bad_fix" | "bad_resolves" | "fix_detail_mismatch" | "wrong_fingerprint";
type FixerReportRead = {
    ok: true;
    report: FixerReport;
} | {
    ok: false;
    refusal: FixerReportRefusal;
};
/**
 * The one FIXER-REPORT block in a fixer's final message. With `expectedFingerprint` set, a report about another
 * fingerprint is refused, so one fixer's report can never resume runs parked on a different cause.
 */
declare function readFixerReport(text: string, expectedFingerprint?: string): FixerReportRead;

/** What one member's dispatch step recorded: a started session, a start that never showed, or a spawn the dispatch refused. */
type DispatchRecord = {
    kind: "started";
    name: string;
    profile: string;
    degraded: boolean;
    agentId: string;
    sessionId: string;
    dispatchedAt: number;
    startedAt: number;
} | {
    kind: "never-started";
    name: string;
    profile: string;
    degraded: boolean;
}
/** `error` is the thrown error's class name, `message` its text. */
 | {
    kind: "refused";
    name: string;
    profile: string;
    degraded: boolean;
    error: string;
    message: string;
};
/** What one await or late read recorded; `timeout` means the verdict deadline passed with no final answer. */
type AwaitRecord = AwaitVerdictResult | {
    kind: "timeout";
};
/**
 * One member failure. `detail` goes into the fixer fingerprint (a profile, an error class, a refusal); `text` is what a
 * repeat is compared on, so the same refusal twice is deterministic and goes to the fixer without spending the rest of its row.
 */
interface ClassifiedFailure {
    class: FailureClass;
    detail?: string;
    text?: string;
}
/**
 * Why one member attempt reached no verdict, or undefined when it reached one. Pure: it reads only the attempt's recorded
 * dispatch and await. A silent session or a WAIT keeps the await polling, so either ends as a timeout.
 */
declare function classifyFailure(dispatch: DispatchRecord, awaited?: AwaitRecord, sonnetFor?: Record<string, string>): ClassifiedFailure | undefined;

/**
 * How the recipe reads a recorded step. A host binds it to its own engine: Shepherd to `step(ctx, id, input, schema)`, the
 * standalone workflow to `codeStep`. A replay returns the recorded answer, which the schema checks.
 */
type StepCall = <R>(stepId: string, input: object, schema: z.ZodType<R>) => Promise<R>;
type CorrectRecord = {
    kind: "asked";
    startedAt: number;
} | {
    kind: "none";
    reason: string;
};

/** The fixer parks runs, so its body takes the parking port beside the review's own. */
type ReviewBodyPorts = ReviewWorkflowPorts & {
    parking: ParkingPort;
};
/** Recorded in each waiting step's input, so a replay waits as the recorded run did. */
interface ReviewTiming {
    pollMs: number;
    /** How long a member's session may take to start, from its spawn. */
    startDeadlineMs: number;
    /** How long a started member may take to write its verdict. */
    verdictDeadlineMs: number;
}
declare const DEFAULT_REVIEW_TIMING: Readonly<ReviewTiming>;
interface DispatchInput {
    target: ReviewTarget;
    shape: ReviewShape;
    profile: string;
    degraded: boolean;
    attempt: 1 | 2;
    kind?: string;
    brief: ReviewHeadInput["brief"];
    timing: ReviewTiming;
}
type AwaitInput = AwaitVerdictInput & {
    timing: ReviewTiming;
};
interface CorrectInput extends ReviewTarget {
    name: string;
    malformed: Malformed;
    ownerBrief?: boolean;
}
interface AggregateStepInput {
    target: ReviewTarget;
    plan: PanelPlan;
    results: readonly MemberResult[];
    fixProof?: string;
    fixProofWaivedAt?: string;
    sonnetFor?: Record<string, string>;
}
/**
 * Spawns the member under its pure name, so a repeat after a crash finds the roster row and spawns nothing; that row's
 * dispatch time is 0 because the name already pins the head. A refused spawn keeps its error class for `classifyFailure`.
 */
declare function dispatchMember(input: DispatchInput, ports: ReviewBodyPorts, signal: AbortSignal): Promise<DispatchRecord>;
/** A malformed final message ends the wait at once, since the reviewer's turn is over; WAIT and silence keep it going. */
declare function awaitMember({ timing, ...input }: AwaitInput, ports: ReviewBodyPorts, signal: AbortSignal): Promise<AwaitRecord>;
/** One read of a timed-out member's transcript before a fresh member is spawned (`sh-late-verdict`). */
declare function lateRead({ timing: _timing, ...input }: AwaitInput, ports: ReviewBodyPorts): Promise<AwaitRecord>;
/** One correction turn in the member's own session; its reply is read by a separate await from the malformed message on. */
declare function correctMember({ name, malformed, ownerBrief, ...target }: CorrectInput, ports: ReviewBodyPorts, signal: AbortSignal): Promise<CorrectRecord>;
declare function aggregateMembers({ target, plan, results, ...proof }: AggregateStepInput, ports: ReviewBodyPorts): Promise<PanelVerdict>;
/** Each heal once, in order; the first that stops the run or cannot act ends the pass. */
declare function healPass({ heals, subject }: {
    heals: readonly HealKind[];
    subject: HealSubject;
}, ports: ReviewBodyPorts): Promise<HealEffect>;
declare function fixerStep(request: FixerRequest, ports: ReviewBodyPorts): Promise<{
    record: FixerRecord;
    outcome: ReviewOutcome;
}>;
/** The intent records the plan the members are dispatched from, so a replay dispatches the recorded panel. */
declare function recordIntent({ plan }: {
    plan: PanelPlan;
}): Promise<{
    plan: PanelPlan;
}>;
declare function preflightBody(input: PreflightReadInput, ports: ReviewBodyPorts): Promise<PreflightSnapshot>;
/**
 * Every read and effect `reviewHead` takes, by its `ReviewStepIds` key. A host registers each under the id it injects,
 * so the recipe stays control flow only.
 */
declare const REVIEW_STEP_BODIES: {
    preflight: typeof preflightBody;
    heal: typeof healPass;
    intent: typeof recordIntent;
    dispatch: typeof dispatchMember;
    await: typeof awaitMember;
    correct: typeof correctMember;
    lateRead: typeof lateRead;
    aggregate: typeof aggregateMembers;
    fixer: typeof fixerStep;
};

/** The rule files one review reads; a hill-climbing variant replaces data here, never the recipe. */
interface ReviewHeadPolicy {
    plan: ReviewPlanPolicy;
    /** Absent means `DEFAULT_RETRY_POLICY`. */
    retry?: RetryPolicy;
    timing?: Partial<ReviewTiming>;
}
interface ReviewHost {
    call: StepCall;
    /**
     * The next recorded step while a run replays, as `WorkflowContext.historyNext`. A step this recipe added is skipped when
     * the record names another step there, so a run recorded before it replays unchanged. Absent means nothing replays.
     */
    historyNext?: () => string | undefined;
    ids?: Partial<ReviewStepIds>;
}
/**
 * Reviews one PR head end to end over recorded steps: preflight, one heal pass, the plan, the member fan-out with each
 * member's policy row, the aggregate and a typed outcome. Control flow only: every read and effect is a step whose body
 * is in `REVIEW_STEP_BODIES`. It reviews a full head; Shepherd keeps its scoped re-review until it calls this recipe.
 */
declare function reviewHead(host: ReviewHost, input: ReviewHeadInput, policy: ReviewHeadPolicy): Promise<ReviewOutcome>;

export { type AggregateStepInput, type AwaitInput, type AwaitRecord, type CarryPort, type CarryProbe, type CheckoutPort, type CheckoutState, type ClassifiedFailure, type CorrectInput, type CorrectRecord, DEFAULT_RETRY_POLICY, DEFAULT_REVIEW_STEP_IDS, DEFAULT_REVIEW_TIMING, type DispatchInput, type DispatchRecord, FAILURE_CLASSES, FIXER_FIXES, FIXER_REPORT_END, FIXER_REPORT_START, type FailureClass, type FixerCase, type FixerEvidence, type FixerFix, type FixerKey, type FixerMember, type FixerMode, type FixerPort, type FixerRecord, type FixerReport, type FixerReportRead, type FixerReportRefusal, type FixerRequest, type HeadPlan, type HeadSnapshot, type HeadroomPort, type HeadroomRead, type HealEffect, type HealKind, type HealPassResult, type HealPorts, type HealRequest, type HealSubject, type HoldMember, type MemberNamer, type ParkedRun, type ParkingPort, type PlanFacts, type PreflightDecision, type PreflightPorts, type PreflightReadInput, type PreflightSnapshot, type ProfilesPort, type ProofRead, type ProofReaderPort, REVIEW_STEP_BODIES, type Resumed, type RetryPolicy, type RetryRule, type RetryStep, type RetryTerminal, type ReviewBodyPorts, type ReviewHeadInput, type ReviewHeadPolicy, type ReviewHost, type ReviewOutcome, type ReviewOutcomeKind, type ReviewPlanPolicy, type ReviewStepIds, type ReviewTiming, type ReviewWorkflowPorts, type SnapshotPort, type StepCall, applyHeal, classifyFailure, fixerBrief, fixerFingerprint, fixerName, healOnce, planForHead, preflight, preflightRead, readFixerReport, requestFixer, resolveFingerprint, reviewHead };
