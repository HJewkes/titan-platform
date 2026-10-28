import { z } from 'zod';

declare const ACTOR_CLASSES: readonly ["owner-terminal", "owner-remote", "coordinator", "worker", "headless", "automation", "decider"];
/** The only classes that may resolve a gate: the owner, at a terminal or through a verified remote channel. */
declare const RESOLVER_CLASSES: readonly ["owner-terminal", "owner-remote"];
/** The only classes a gate's rule may name as a delegate resolver; anything a delegate answers still goes through `authorize`. */
declare const DELEGATE_RESOLVER_CLASSES: readonly ["coordinator"];
declare const ACTION_CLASSES: readonly ["merge", "release", "secret-read", "untrusted-ingest", "private-to-public", "private-egress", "hardware-actuate", "hardware-stop", "destructive-remote", "destructive-local", "destructive-foreign", "agent-retire", "spawn", "spend-over-cap", "authority-config", "human-verb", "answer-question", "pr-close", "deploy-resume", "fleet-config"];
declare const VERDICTS: readonly ["allow", "gate", "deny"];
/** Codes for the record each rule expects to leave behind, from a decision record to a device read-back. */
declare const EVIDENCE_KINDS: readonly ["E-dec", "E-gate", "E-ref", "E-byp", "E-gh", "E-npm", "E-spn", "E-prin", "E-dev", "E-rev"];
/** Conditions read from `facts.merge`. */
declare const MERGE_CONDITION_KINDS: readonly ["resolver-is-dispatched-reviewer", "verdict-merge-at-head", "verdict-merge-carried-tree-equal", "verdict-merge-carried-remerge-clean", "verdict-merge-carried-merge-up-disjoint", "pr-kind-not-security", "required-contexts-green", "no-non-green-run", "merge-tree-clean", "repo-not-frozen", "no-protected-path-change", "seat-grants-merge-on-green-approve"];
/** Conditions read from `facts.question`, the gate a decider would answer. */
declare const QUESTION_CONDITION_KINDS: readonly ["gate-rule-is-question", "category-mode-auto"];
/** Facts a conditional rule checks on the request; the rule applies only when every one holds. */
declare const CONDITION_KINDS: readonly ["resolver-is-dispatched-reviewer", "verdict-merge-at-head", "verdict-merge-carried-tree-equal", "verdict-merge-carried-remerge-clean", "verdict-merge-carried-merge-up-disjoint", "pr-kind-not-security", "required-contexts-green", "no-non-green-run", "merge-tree-clean", "repo-not-frozen", "no-protected-path-change", "seat-grants-merge-on-green-approve", "gate-rule-is-question", "category-mode-auto"];
/** What made an agent identity tainted; `inbound-message` is reserved for an external door that does not exist yet. */
declare const TAINT_KINDS: readonly ["web-fetch", "web-search", "external-tool", "inbound-message", "untrusted-item", "inherited"];
type ActorClass = (typeof ACTOR_CLASSES)[number];
type ResolverClass = (typeof RESOLVER_CLASSES)[number];
type DelegateResolverClass = (typeof DELEGATE_RESOLVER_CLASSES)[number];
type ActionClass = (typeof ACTION_CLASSES)[number];
type Verdict = (typeof VERDICTS)[number];
type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
type MergeConditionKind = (typeof MERGE_CONDITION_KINDS)[number];
type QuestionConditionKind = (typeof QUESTION_CONDITION_KINDS)[number];
type ConditionKind = (typeof CONDITION_KINDS)[number];
type TaintKind = (typeof TAINT_KINDS)[number];

interface AgentIdentity {
    agentId: string;
    sessionId: string;
}
interface CheckRunFact {
    name: string;
    appId: number;
    headSha: string;
    /** GitHub's conclusion; `null` while the run is queued or in progress. */
    conclusion: string | null;
}
/** The tree-equality probe's answer for a head that updates a reviewed head; the caller reads it from its probe step, never from reviewer text. */
interface CarryFact {
    /** The head whose MERGE verdict is carried. */
    fromHead: string;
    /** The head the carry is for. */
    head: string;
    headTree: string;
    /** For a remerge rule, the tree git's own remerge of the head's two parents writes, conflict markers and all. */
    mergeTree: string;
    /** Which probe carried the verdict; absent reads as `tree-equal`. */
    rule?: "tree-equal" | "remerge-empty" | "remerge-generated-only" | "merge-up-disjoint";
    /** For a remerge rule: every path the head's remerge-diff or the remerge's conflicts touch. */
    remergePaths?: string[];
    /** For a remerge rule: the paths among `remergePaths` that the repo declares generated. */
    generatedPaths?: string[];
    /** For `merge-up-disjoint`: every path the merge's base side (merge-base to second parent) changed. */
    basePaths?: string[];
    /** For `merge-up-disjoint`: the head's first parent, which the probe found on the reviewed line. */
    firstParent?: string;
}
/** What the caller observed about a pull request it wants to merge. The evaluator re-derives every condition from these. */
interface MergeFacts {
    head: string;
    resolver: AgentIdentity;
    dispatchedReviewer: AgentIdentity;
    verdict: {
        value: string;
        head: string;
    };
    requiredContexts: string[];
    /** Check-run app ids the caller trusts; the package pins none. */
    allowedApps: number[];
    /** Per-context override of `allowedApps`: a run of a listed context counts only from these apps. Absent means `allowedApps` for every context. */
    contextApps?: Record<string, number[]>;
    checkRuns: CheckRunFact[];
    mergeTreeClean: boolean;
    repoFrozen: boolean;
    /** Every path the pull request touches, including both sides of a rename. */
    changedPaths: string[];
    seatGrants: string[];
    carry?: CarryFact;
    /** The kind the pull request was registered with; absent when unregistered. */
    kind?: string;
}
/** What the caller observed about the question gate a decider wants to answer. */
interface QuestionFacts {
    /** The kind of rule the gate was opened under; only `question` passes. */
    ruleKind: string;
    /** The decision mode of the question's category; only `auto` passes. */
    mode: string;
}
interface ConditionFacts {
    merge?: MergeFacts;
    question?: QuestionFacts;
}
/** Whether a base-side path bars a MERGE carry across a merge-up; a path that cannot be compared exactly counts as fenced. */
declare function isCarryFencedPath(path: unknown): boolean;
/** The conditions that do not hold. Missing or non-plain facts fail every condition, so a caller that observed nothing gets nothing. */
declare function unmetConditions(conditions: readonly ConditionKind[], facts: ConditionFacts | undefined): ConditionKind[];

declare const ruleSchema: z.ZodObject<{
    id: z.ZodString;
    action: z.ZodEnum<{
        merge: "merge";
        release: "release";
        "secret-read": "secret-read";
        "untrusted-ingest": "untrusted-ingest";
        "private-to-public": "private-to-public";
        "private-egress": "private-egress";
        "hardware-actuate": "hardware-actuate";
        "hardware-stop": "hardware-stop";
        "destructive-remote": "destructive-remote";
        "destructive-local": "destructive-local";
        "destructive-foreign": "destructive-foreign";
        "agent-retire": "agent-retire";
        spawn: "spawn";
        "spend-over-cap": "spend-over-cap";
        "authority-config": "authority-config";
        "human-verb": "human-verb";
        "answer-question": "answer-question";
        "pr-close": "pr-close";
        "deploy-resume": "deploy-resume";
        "fleet-config": "fleet-config";
    }>;
    actor: z.ZodEnum<{
        "owner-terminal": "owner-terminal";
        "owner-remote": "owner-remote";
        coordinator: "coordinator";
        worker: "worker";
        headless: "headless";
        automation: "automation";
        decider: "decider";
    }>;
    verdict: z.ZodEnum<{
        allow: "allow";
        gate: "gate";
        deny: "deny";
    }>;
    resolvers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        "owner-terminal": "owner-terminal";
        "owner-remote": "owner-remote";
    }>>>;
    taintEscalates: z.ZodOptional<z.ZodBoolean>;
    condition: z.ZodOptional<z.ZodString>;
    when: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        "resolver-is-dispatched-reviewer": "resolver-is-dispatched-reviewer";
        "verdict-merge-at-head": "verdict-merge-at-head";
        "verdict-merge-carried-tree-equal": "verdict-merge-carried-tree-equal";
        "verdict-merge-carried-remerge-clean": "verdict-merge-carried-remerge-clean";
        "verdict-merge-carried-merge-up-disjoint": "verdict-merge-carried-merge-up-disjoint";
        "pr-kind-not-security": "pr-kind-not-security";
        "required-contexts-green": "required-contexts-green";
        "no-non-green-run": "no-non-green-run";
        "merge-tree-clean": "merge-tree-clean";
        "repo-not-frozen": "repo-not-frozen";
        "no-protected-path-change": "no-protected-path-change";
        "seat-grants-merge-on-green-approve": "seat-grants-merge-on-green-approve";
        "gate-rule-is-question": "gate-rule-is-question";
        "category-mode-auto": "category-mode-auto";
    }>>>;
    evidence: z.ZodArray<z.ZodEnum<{
        "E-dec": "E-dec";
        "E-gate": "E-gate";
        "E-ref": "E-ref";
        "E-byp": "E-byp";
        "E-gh": "E-gh";
        "E-npm": "E-npm";
        "E-spn": "E-spn";
        "E-prin": "E-prin";
        "E-dev": "E-dev";
        "E-rev": "E-rev";
    }>>;
}, z.core.$strip>;
type Rule = z.infer<typeof ruleSchema>;
interface PolicyTable {
    version: string;
    rules: Rule[];
}
/** Validates a table: every (action, actor) pair has exactly one unconditional rule, and only owner classes resolve gates. */
declare const policyTableSchema: z.ZodType<PolicyTable>;

/** Long enough for a tool name, a host, an item id or an agent id; short enough that fetched content never fits. */
declare const TAINT_REF_MAX_LENGTH = 200;
/** One reason an agent identity is tainted. `ref` is a short safe label, never fetched content. */
declare const taintSourceSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        "web-fetch": "web-fetch";
        "web-search": "web-search";
        "external-tool": "external-tool";
        "inbound-message": "inbound-message";
        "untrusted-item": "untrusted-item";
        inherited: "inherited";
    }>;
    ref: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>;
type TaintSource = z.infer<typeof taintSourceSchema>;

interface AuthorityRequest {
    action: ActionClass;
    actor: {
        class: ActorClass;
        id: string;
    };
    tainted: boolean;
    subject: Record<string, string>;
    /** Observed facts that a conditional rule (one with `when`) checks before it applies. */
    facts?: ConditionFacts;
}
type Decision = {
    verdict: "allow";
    ruleId: string;
} | {
    verdict: "gate";
    ruleId: string;
    resolvers: ResolverClass[];
    reason: string;
} | {
    verdict: "deny";
    ruleId: string | null;
    reason: string;
};
/** Decides one request against a table. Pure: no clock, no environment, and no match means deny. */
declare function evaluate(table: PolicyTable, request: AuthorityRequest): Decision;
/** Whether a resolver may resolve the gate a rule opens. Agents, automation and tainted sessions never may. */
declare function canResolve(table: PolicyTable, ruleId: string, resolver: {
    class: ActorClass;
    tainted: boolean;
}): boolean;

/** The owner-approved decision table, validated on load. The same data ships as `@titan-design/authority/table.json`. */
declare const DEFAULT_TABLE: PolicyTable;

export { ACTION_CLASSES, ACTOR_CLASSES, type ActionClass, type ActorClass, type AgentIdentity, type AuthorityRequest, CONDITION_KINDS, type CarryFact, type CheckRunFact, type ConditionFacts, type ConditionKind, DEFAULT_TABLE, DELEGATE_RESOLVER_CLASSES, type Decision, type DelegateResolverClass, EVIDENCE_KINDS, type EvidenceKind, MERGE_CONDITION_KINDS, type MergeConditionKind, type MergeFacts, type PolicyTable, QUESTION_CONDITION_KINDS, type QuestionConditionKind, type QuestionFacts, RESOLVER_CLASSES, type ResolverClass, type Rule, TAINT_KINDS, TAINT_REF_MAX_LENGTH, type TaintKind, type TaintSource, VERDICTS, type Verdict, canResolve, evaluate, isCarryFencedPath, policyTableSchema, taintSourceSchema, unmetConditions };
