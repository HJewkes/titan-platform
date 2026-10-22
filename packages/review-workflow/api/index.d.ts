import { ReviewTarget, ReviewShape, PanelVerdict, ReviewRequest, PanelMember, ReviewerAgent, PrFacts, Headroom, ReviewerDispatch, ReviewerReader, ReviewClock } from '@titan-design/review-panel';
import { LineSource } from '@titan-design/evidence';
import { PullRequest } from '@titan-design/github';

/** One review of one PR head; the ports carry every read and effect, so the input names only what the caller already knows. */
interface ReviewHeadInput {
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
declare const FAILURE_CLASSES: readonly ["never-started", "start-refused:profile", "start-refused:headroom", "start-refused:other", "timeout", "throttled", "usage-limit", "malformed", "stale-head", "shortfall", "deterministic-repeat", "schema-drift", "proof-spec-problem"];
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
}
interface SnapshotPort {
    read(target: ReviewTarget): Promise<HeadSnapshot>;
}
/** `line` is the raw `fix-proof/v1` line; `none` means no proof ran; `unread` means one may have and could not be read. */
type ProofRead = {
    kind: "line";
    line: string;
} | {
    kind: "none";
} | {
    kind: "unread";
    reason: string;
};
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
    /** Absent means review-panel's `memberName`. */
    namer?: MemberNamer;
}

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
type FixerKey = "profile" | "dispatch" | "timeout" | "parser" | "plan-aggregate-mismatch" | "repeat" | "schema";
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

export { type CarryPort, type CarryProbe, type CheckoutPort, type CheckoutState, DEFAULT_RETRY_POLICY, DEFAULT_REVIEW_STEP_IDS, FAILURE_CLASSES, FIXER_FIXES, FIXER_REPORT_END, FIXER_REPORT_START, type FailureClass, type FixerCase, type FixerEvidence, type FixerFix, type FixerKey, type FixerMember, type FixerMode, type FixerPort, type FixerRecord, type FixerReport, type FixerReportRead, type FixerReportRefusal, type FixerRequest, type HeadSnapshot, type HeadroomPort, type HeadroomRead, type HealKind, type MemberNamer, type ParkedRun, type ParkingPort, type ProofRead, type ProofReaderPort, type Resumed, type RetryPolicy, type RetryRule, type RetryStep, type RetryTerminal, type ReviewHeadInput, type ReviewOutcome, type ReviewOutcomeKind, type ReviewStepIds, type ReviewWorkflowPorts, type SnapshotPort, fixerBrief, fixerFingerprint, fixerName, readFixerReport, requestFixer, resolveFingerprint };
