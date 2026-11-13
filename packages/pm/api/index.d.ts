import { z } from 'zod';
export { B as Bet, a as BetSchema, F as Freeze, b as FreezeEndCondition, c as FreezeEndConditionSchema, d as FreezeSchema, O as OutOfScope, e as OutOfScopeSchema, f as Outcome, g as OutcomeSchema, h as OwnerIntentRef, i as OwnerIntentRefSchema, P as Prediction, j as PredictionSchema } from './planning.js';

declare const DELIVERABLE_ID_REGEX: RegExp;
declare const TaskSchema: z.ZodObject<{
    field_origin: z.ZodOptional<z.ZodRecord<z.ZodEnum<{
        class: "class";
        source: "source";
        rank: "rank";
        done_reason: "done_reason";
        blocked_on: "blocked_on";
        serves: "serves";
        source_ref: "source_ref";
        filed_by: "filed_by";
        bet: "bet";
        fold: "fold";
        owner_steps: "owner_steps";
    }> & z.core.$partial, z.ZodString>>;
    class: z.ZodOptional<z.ZodEnum<{
        product: "product";
        upkeep: "upkeep";
    }>>;
    serves: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodString]>>;
    source: z.ZodOptional<z.ZodEnum<{
        owner: "owner";
        plan: "plan";
        "follow-up": "follow-up";
        review: "review";
        sweep: "sweep";
        audit: "audit";
        coordinator: "coordinator";
        incident: "incident";
    }>>;
    source_ref: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        from_pr: z.ZodString;
        from_task: z.ZodString;
        head: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>]>>;
    filed_by: z.ZodOptional<z.ZodString>;
    rank: z.ZodOptional<z.ZodEnum<{
        p0: "p0";
        p1: "p1";
        p2: "p2";
        p3: "p3";
    }>>;
    done_reason: z.ZodOptional<z.ZodEnum<{
        shipped: "shipped";
        superseded: "superseded";
        duplicate: "duplicate";
        moot: "moot";
        "wont-do": "wont-do";
    }>>;
    blocked_on: z.ZodOptional<z.ZodEnum<{
        owner: "owner";
        decision: "decision";
        task: "task";
        external: "external";
    }>>;
    bet: z.ZodOptional<z.ZodString>;
    fold: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"independent">, z.ZodString]>>;
    owner_steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            release: "release";
            restart: "restart";
            credential: "credential";
            sitting: "sitting";
            config: "config";
            publish: "publish";
        }>;
        note: z.ZodString;
    }, z.core.$strict>>>;
    id: z.ZodString;
    parent: z.ZodOptional<z.ZodString>;
    dep: z.ZodOptional<z.ZodArray<z.ZodString>>;
    deliverables: z.ZodOptional<z.ZodArray<z.ZodString>>;
    title: z.ZodString;
    priority: z.ZodNumber;
    severity: z.ZodOptional<z.ZodEnum<{
        critical: "critical";
        high: "high";
        medium: "medium";
        low: "low";
    }>>;
    estimate: z.ZodOptional<z.ZodNumber>;
    done_when: z.ZodOptional<z.ZodString>;
    status: z.ZodString;
    kind: z.ZodOptional<z.ZodString>;
    cos: z.ZodOptional<z.ZodString>;
    area: z.ZodOptional<z.ZodString>;
    due: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    notes: z.ZodOptional<z.ZodString>;
    created: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
    started_at: z.ZodOptional<z.ZodString>;
    updated: z.ZodString;
    done_at: z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodString, z.ZodString]>, z.ZodNull]>;
    actual: z.ZodOptional<z.ZodObject<{
        agentHours: z.ZodOptional<z.ZodNumber>;
        reviewAgentHours: z.ZodOptional<z.ZodNumber>;
        usd: z.ZodOptional<z.ZodNumber>;
        serviceWallHours: z.ZodOptional<z.ZodNumber>;
        peakContext: z.ZodOptional<z.ZodNumber>;
        contextAtFirstDeliverable: z.ZodOptional<z.ZodNumber>;
        at: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    claimedHours: z.ZodOptional<z.ZodArray<z.ZodObject<{
        hours: z.ZodNumber;
        by: z.ZodString;
        at: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>;
type Task = z.infer<typeof TaskSchema>;

declare const InitiativeVisibilitySchema: z.ZodEnum<{
    "owner-only": "owner-only";
    "agent-visible": "agent-visible";
}>;
type InitiativeVisibility = z.infer<typeof InitiativeVisibilitySchema>;
interface InitiativeBriefRef {
    slug: string;
    /** The brief's parsed front matter, or null when brief.md is missing or its YAML does not parse. */
    brief: unknown;
}
/**
 * The one test every agent-facing reader applies. It fails closed: a missing or unparsable
 * brief, or a visibility value outside the closed set, is owner-only.
 */
declare function isAgentVisible(initiative: InitiativeBriefRef): boolean;

/** A brief's `task_require`: the provenance fields every task filed in that initiative must carry. */
declare const TaskRequireSchema: z.ZodArray<z.ZodEnum<{
    class: "class";
    source: "source";
    serves: "serves";
    source_ref: "source_ref";
}>>;
type TaskRequire = z.infer<typeof TaskRequireSchema>;
/** Answers whether a bet id names a bet that exists. The planning store (TP-5453 P3) provides the real one. */
interface BetLookup {
    has(betId: string): Promise<boolean>;
}
/** Why a task's `bet` cannot be written, or null when it names no bet or a bet that exists. */
declare function betProblem({ bet: betId }: {
    bet?: string;
}, lookup: BetLookup): Promise<string | null>;

declare const DELIVERABLE_STATUSES: readonly ["planned", "active", "shipped", "dropped"];
/** One deliverable, stored at `<deliverablesDir>/<id>.yml`. */
declare const DeliverableSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    done_when: z.ZodString;
    target: z.ZodUnion<readonly [z.ZodString, z.ZodNull]>;
    status: z.ZodEnum<{
        shipped: "shipped";
        active: "active";
        dropped: "dropped";
        planned: "planned";
    }>;
    owner_seat: z.ZodString;
    tags: z.ZodArray<z.ZodString>;
    created: z.ZodString;
    updated: z.ZodString;
    shipped_at: z.ZodUnion<readonly [z.ZodString, z.ZodNull]>;
}, z.core.$strip>;
type Deliverable = z.infer<typeof DeliverableSchema>;
type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];
/** One file read from the deliverables directory: its basename and its parsed YAML. */
interface DeliverableEntry {
    file: string;
    parsed: unknown;
}
declare function deliverablesDir(activeRoot: string): string;
declare function deliverablePath(activeRoot: string, id: string): string;
/**
 * Validates the `.yml` files of the deliverables directory, which the host has read and parsed.
 * A missing directory is an empty registry, so the host passes `[]` and gets `[]` back. Each
 * file must be named after the id it holds, which also makes ids unique. Throws on the first
 * bad file, naming it.
 */
declare function parseDeliverableRegistry(entries: readonly DeliverableEntry[]): Deliverable[];

interface Edges {
    parent: string | null;
    dep: string[];
}
type EdgeField = "parent" | "dep";
/** A proposed edit to one task's edges. An omitted field keeps the task's current edges. */
interface EdgeChange {
    id: string;
    parent?: string | null;
    dep?: string[];
}
type EdgeError = {
    kind: "unknown-id";
    id: string;
    field: EdgeField;
    ref: string;
} | {
    kind: "cycle";
    field: EdgeField;
    ids: string[];
};
interface CrossInitiativeParentWarning {
    kind: "cross-initiative-parent";
    id: string;
    parent: string;
}
interface EdgeCheck {
    errors: EdgeError[];
    warnings: CrossInitiativeParentWarning[];
}
/**
 * Returns a task's parent and dep edges. A field, when present, wins outright. Without it the
 * edge is read from `epic:`/`parent:` or `dep:`/`blocked-by:` tags whose value is a task id.
 *
 * The tag read is a migration fallback, not a lasting path: tags are for retrieval only
 * (decisions item 90), and this fallback goes once the edge tags are migrated to fields.
 * `blocks:` is not read here, because it names the inverse edge on the other task; only the
 * migration can turn it into that task's `dep`.
 */
declare function readEdges(task: Task): Edges;
/**
 * Checks a proposed edge change against the current tasks. Errors are fatal: an edge to an id
 * not in `tasks`, or a cycle through the changed task, listed as the ids on the cycle in edge
 * order from the changed task. A dep may cross initiatives. A parent in another initiative is
 * returned as a `cross-initiative-parent` warning, not an error, until the owner rules on it.
 */
declare function checkEdges(tasks: readonly Task[], change: EdgeChange): EdgeCheck;

/** Something a repo review proposed that must end with a disposition row. */
interface ReviewItem {
    id: string;
    source: "recommendation" | "topic";
    /** 1-based line in SUMMARY.md for a recommendation, in topics-judged.tsv for a topic. */
    line: number;
}
/**
 * Lists the top-level bullets under SUMMARY.md's "Integration recommendations" (or plain
 * "Recommendations") heading, up to the next level-1 or level-2 heading. A bullet led by a bold
 * label such as `**A1.` is that label; any other bullet is `R<n>`, its ordinal in the section.
 * Nested bullets and fenced code are not recommendations. Throws when the heading is missing,
 * so a renamed section cannot pass the gate by having nothing to disposition.
 */
declare function summaryRecommendations(summary: string): ReviewItem[];
/** Lists the P1 and P2 topics of a review's `topics-judged.tsv`, in file order. */
declare function prioritizedTopics(topicsTsv: string): ReviewItem[];

/**
 * How a review item ended. `task`, `dup` and `fold` name a task id: the task filed for it, the
 * task it duplicates, or the task it was folded into. `drop` and `pending-owner` give a reason;
 * `pending-owner` is for a brief that says "none filed", where the owner's plan file decides.
 */
declare const DISPOSITION_KINDS: readonly ["task", "dup", "fold", "drop", "pending-owner"];
declare const DispositionRowSchema: z.ZodObject<{
    rec_id: z.ZodString;
    summary_line: z.ZodString;
    disposition: z.ZodEnum<{
        task: "task";
        fold: "fold";
        dup: "dup";
        drop: "drop";
        "pending-owner": "pending-owner";
    }>;
    ref: z.ZodString;
}, z.core.$strip>;
type DispositionRow = z.infer<typeof DispositionRowSchema>;
type DispositionKind = (typeof DISPOSITION_KINDS)[number];
/** Parses `dispositions.tsv`. Throws on the first bad row, naming its line. */
declare function parseDispositions(tsv: string): DispositionRow[];
interface DispositionCheck {
    ok: boolean;
    /** Review items with no row. */
    missing: ReviewItem[];
    /** Row ids that name no review item, usually a typo that would otherwise hide a missing row. */
    unknown: string[];
    /** Ids with more than one row, so the item's ending is ambiguous. */
    duplicated: string[];
}
/**
 * Matches rows to review items by id, never by count: three items and three rows still fail
 * when one row names an item twice or names something that is not an item.
 */
declare function checkDispositions(items: readonly ReviewItem[], rows: readonly DispositionRow[]): DispositionCheck;

/** How urgent a judged topic is, most urgent first. */
declare const TOPIC_PRIORITIES: readonly ["P1", "P2", "P3", "P4"];
/** How titan compares with the reviewed repo on a topic, as the judge writes it. */
declare const TOPIC_VERDICTS: readonly ["missing", "have-worse", "lost", "ported-partial", "ported", "have-better", "already-have", "dropped-on-purpose", "never-worked", "out-of-scope"];
type TopicPriority = (typeof TOPIC_PRIORITIES)[number];
type TopicVerdict = (typeof TOPIC_VERDICTS)[number];
declare const TOPIC_COLUMNS: readonly ["topic_id", "tier", "title", "verdict", "priority", "titan_evidence", "reason"];
declare const CLAIM_COLUMNS: readonly ["id", "source", "status", "evidence", "claim"];
type TopicColumn = (typeof TOPIC_COLUMNS)[number];
type ClaimColumn = (typeof CLAIM_COLUMNS)[number];
/**
 * One row of `topics-judged.tsv`. Verdict and priority stay plain strings so a review that
 * coins a new verdict still parses; compare them against the vocabularies where it matters.
 */
type TopicRow = Record<TopicColumn, string> & {
    /** 1-based line in the file. */
    line: number;
    /** Every column beyond the common seven, which differ between review generations. */
    extra: Record<string, string>;
};
/** One row of `claims-audit.tsv`. The optional columns are absent when the header lacks them. */
type ClaimRow = Record<ClaimColumn, string> & {
    line: number;
    basis?: string;
    note?: string;
    wave?: string;
};
/** Headless spend of a review, from `runs.tsv`. Agent sessions are not in that file. */
interface RunCost {
    usd: number;
    calls: number;
    errors: number;
    /** The latest `ts`, or null when no row has one. */
    lastTs: string | null;
}
/** Parses `topics-judged.tsv`. Throws, naming `file`, when a common column is missing. */
declare function parseTopicsJudged(tsv: string, file?: string): TopicRow[];
/** Parses `claims-audit.tsv`. Throws, naming `file`, when a required column is missing. */
declare function parseClaimsAudit(tsv: string, file?: string): ClaimRow[];
/** The header bullets of a review's README.md. Every key is optional; older READMEs omit some. */
interface ReviewPin {
    remote?: string;
    /** The pinned commit, short or full, without the date and subject that often follow it. */
    head?: string;
    /** Free text written when the README was, often stale; never derive a review's state from it. */
    status?: string;
    pinned?: string;
    mode?: string;
    focus?: string;
}
/**
 * Reads the `- key: value` bullets of a review README. Keys match in any case (`Remote:` and
 * `remote:` both occur), and the first bullet for a key wins. HEAD keeps only its leading
 * hash, and remote only its leading URL when it starts with one.
 */
declare function readReviewPin(readme: string): ReviewPin;
/** Sums `runs.tsv`. An empty cost counts as zero; any other non-number throws, naming its line. */
declare function sumRunCost(tsv: string, file?: string): RunCost;

/**
 * Splits TSV text into records keyed by the header row, each with its 1-based line in the
 * file. Blank lines are skipped. Throws when a required column is missing from the header, so
 * a renamed column fails loudly instead of reading as empty.
 */
declare function readTsv(text: string, required: readonly string[], label: string): {
    line: number;
    fields: Record<string, string>;
}[];

interface TaskTreeNode {
    id: string;
    title: string;
    status: string;
    estimate: number | null;
    depth: number;
    children: TaskTreeNode[];
}
interface TaskFloat {
    id: string;
    duration: number;
    earlyStart: number;
    earlyFinish: number;
    lateStart: number;
    lateFinish: number;
    float: number;
}
interface ExternalDep {
    task: string;
    dep: string;
}
interface CriticalPathOptions {
    deliverable?: string;
}
interface CriticalPathResult {
    /** Every task outside a cycle, in input order. */
    tasks: TaskFloat[];
    /** The zero-float task ids, by early start then input order. */
    criticalPath: string[];
    /** Remaining critical path length in points: the latest early finish. */
    length: number;
    /** True when cycles exist: their tasks and the edges through them add nothing, so `length` may be short. */
    lowerBound: boolean;
    /** Each cycle's task ids in input order; cycles ordered by their first member. */
    cycles: string[][];
    externalDeps: ExternalDep[];
    unestimated: string[];
}
/**
 * The subtree under `rootId` by `parent` edges, children in input order, or null when no task
 * has that id. A repeated id keeps its first task, and a parent cycle is cut where it would
 * revisit a task, so the walk always ends.
 */
declare function taskTree(tasks: readonly Task[], rootId: string): TaskTreeNode | null;
/**
 * Total float per open task from a forward and backward pass over the dep edges, with the
 * estimate in points as the duration. Float 0 means the task is on the critical path. Pure and
 * total: bad input is reported, never thrown.
 *
 * - The set is the open tasks, narrowed to those listing `deliverable` when one is given. A dep
 *   naming a task outside it (closed, another deliverable, unknown) is satisfied: it constrains
 *   nothing and is listed in `externalDeps`.
 * - A missing, NaN, infinite or negative estimate is duration 0 and is listed in `unestimated`.
 * - Tasks in a dep cycle are listed in `cycles` and get no float; a dep on one constrains
 *   nothing, so with any cycle `length` is only a lower bound (`lowerBound`).
 * - A repeated id keeps its first task.
 */
declare function criticalPath(tasks: readonly Task[], options?: CriticalPathOptions): CriticalPathResult;

declare const StatusEntrySchema: z.ZodObject<{
    id: z.ZodString;
    closed: z.ZodBoolean;
    dispatchable: z.ZodBoolean;
}, z.core.$strip>;
declare const AreaEntrySchema: z.ZodObject<{
    id: z.ZodString;
    tier: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<"ui">, z.ZodLiteral<"product">]>;
    path: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** The closed category axes, read from `<activeRoot>/titan-platform/categories.yml`. */
declare const CategoryRegistrySchema: z.ZodObject<{
    kind: z.ZodArray<z.ZodString>;
    status: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        closed: z.ZodBoolean;
        dispatchable: z.ZodBoolean;
    }, z.core.$strip>>;
    cos: z.ZodArray<z.ZodString>;
    area: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        tier: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<"ui">, z.ZodLiteral<"product">]>;
        path: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type CategoryRegistry = z.infer<typeof CategoryRegistrySchema>;
type StatusEntry = z.infer<typeof StatusEntrySchema>;
type AreaEntry = z.infer<typeof AreaEntrySchema>;
type CategoryAxis = "kind" | "status" | "cos" | "area";
/** The statuses a root with no registry accepts: the set tasks used before the registry existed. */
declare const BUILT_IN_STATUSES: readonly StatusEntry[];
declare function categoriesPath(activeRoot: string): string;
/**
 * Validates the parsed contents of categories.yml. Pass `undefined` when the file does not exist,
 * which returns null: a root with no registry skips validation of kind, cos and area. An empty file
 * parses to null, not undefined, and fails, so a registry cannot be switched off by emptying it.
 */
declare function parseCategoryRegistry(parsed: unknown): CategoryRegistry | null;
type CategoryError = {
    kind: "unknown-category";
    id: string;
    axis: CategoryAxis;
    value: string;
    allowed: string[];
} | {
    kind: "cos-fixed-without-due";
    id: string;
};
type CategorizedTask = Pick<Task, "id" | "status" | "kind" | "cos" | "area" | "due">;
/**
 * Checks a task's category values against the registry, one error per unknown value. A null
 * registry checks status against BUILT_IN_STATUSES and skips kind, cos and area. A task with
 * cos `fixed` and no `due` is an error with or without a registry, because the date is what
 * makes the class of service fixed.
 */
declare function checkCategories(task: CategorizedTask, registry: CategoryRegistry | null): CategoryError[];

export { type AreaEntry, BUILT_IN_STATUSES, type BetLookup, type CategorizedTask, type CategoryAxis, type CategoryError, type CategoryRegistry, CategoryRegistrySchema, type ClaimRow, type CriticalPathOptions, type CriticalPathResult, type CrossInitiativeParentWarning, DELIVERABLE_ID_REGEX, DELIVERABLE_STATUSES, DISPOSITION_KINDS, type Deliverable, type DeliverableEntry, DeliverableSchema, type DeliverableStatus, type DispositionCheck, type DispositionKind, type DispositionRow, DispositionRowSchema, type EdgeChange, type EdgeCheck, type EdgeError, type EdgeField, type Edges, type ExternalDep, type InitiativeBriefRef, type InitiativeVisibility, InitiativeVisibilitySchema, type ReviewItem, type ReviewPin, type RunCost, type StatusEntry, TOPIC_PRIORITIES, TOPIC_VERDICTS, type Task, type TaskFloat, type TaskRequire, TaskRequireSchema, TaskSchema, type TaskTreeNode, type TopicPriority, type TopicRow, type TopicVerdict, betProblem, categoriesPath, checkCategories, checkDispositions, checkEdges, criticalPath, deliverablePath, deliverablesDir, isAgentVisible, parseCategoryRegistry, parseClaimsAudit, parseDeliverableRegistry, parseDispositions, parseTopicsJudged, prioritizedTopics, readEdges, readReviewPin, readTsv, sumRunCost, summaryRecommendations, taskTree };

// ./dist/planning.d.ts
import { z } from 'zod';

/** Where the owner said it: the record id plus the reference to the exact quote. */
declare const OwnerIntentRefSchema: z.ZodObject<{
    intent_ref: z.ZodString;
    quote_ref: z.ZodString;
}, z.core.$strict>;
type OwnerIntentRef = z.infer<typeof OwnerIntentRefSchema>;
/** One success statement per initiative: an outcome the owner would notice and the measure for it. */
declare const OutcomeSchema: z.ZodObject<{
    id: z.ZodString;
    initiative: z.ZodString;
    statement: z.ZodString;
    measure: z.ZodString;
    state: z.ZodEnum<{
        draft: "draft";
        active: "active";
        retired: "retired";
    }>;
    owner_intent: z.ZodOptional<z.ZodObject<{
        intent_ref: z.ZodString;
        quote_ref: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
type Outcome = z.infer<typeof OutcomeSchema>;
/** What the bet is expected to move, from where, to what, and when the reading is due. */
declare const PredictionSchema: z.ZodObject<{
    metric: z.ZodString;
    direction: z.ZodEnum<{
        increase: "increase";
        decrease: "decrease";
    }>;
    baseline: z.ZodNumber;
    expected: z.ZodNumber;
    read_by: z.ZodString;
}, z.core.$strict>;
type Prediction = z.infer<typeof PredictionSchema>;
declare const BetSchema: z.ZodObject<{
    id: z.ZodString;
    initiative: z.ZodString;
    week: z.ZodString;
    outcome: z.ZodString;
    order: z.ZodNumber;
    tasks: z.ZodOptional<z.ZodArray<z.ZodString>>;
    selector: z.ZodOptional<z.ZodString>;
    prediction: z.ZodObject<{
        metric: z.ZodString;
        direction: z.ZodEnum<{
            increase: "increase";
            decrease: "decrease";
        }>;
        baseline: z.ZodNumber;
        expected: z.ZodNumber;
        read_by: z.ZodString;
    }, z.core.$strict>;
    state: z.ZodEnum<{
        proposed: "proposed";
        selected: "selected";
        dropped: "dropped";
        done: "done";
    }>;
    cites: z.ZodOptional<z.ZodArray<z.ZodObject<{
        intent_ref: z.ZodString;
        quote_ref: z.ZodString;
    }, z.core.$strict>>>;
}, z.core.$strict>;
type Bet = z.infer<typeof BetSchema>;
declare const FreezeEndConditionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"date">;
    date: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"task-done">;
    task: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"measure">;
    metric: z.ZodString;
    direction: z.ZodEnum<{
        increase: "increase";
        decrease: "decrease";
    }>;
    threshold: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"owner">;
}, z.core.$strict>], "kind">;
type FreezeEndCondition = z.infer<typeof FreezeEndConditionSchema>;
declare const FreezeSchema: z.ZodObject<{
    ended_on: z.ZodOptional<z.ZodString>;
    intent_ref: z.ZodString;
    quote_ref: z.ZodString;
    id: z.ZodString;
    initiative: z.ZodString;
    tag: z.ZodOptional<z.ZodString>;
    selector: z.ZodOptional<z.ZodString>;
    reason: z.ZodString;
    end_condition: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"date">;
        date: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"task-done">;
        task: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"measure">;
        metric: z.ZodString;
        direction: z.ZodEnum<{
            increase: "increase";
            decrease: "decrease";
        }>;
        threshold: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"owner">;
    }, z.core.$strict>], "kind">;
    set_by: z.ZodEnum<{
        owner: "owner";
        decider: "decider";
    }>;
}, z.core.$strict>;
type Freeze = z.infer<typeof FreezeSchema>;
/** Work the owner ruled out, with the reference and date of the statement that did so. */
declare const OutOfScopeSchema: z.ZodObject<{
    date: z.ZodString;
    revisit_when: z.ZodOptional<z.ZodString>;
    intent_ref: z.ZodString;
    quote_ref: z.ZodString;
    id: z.ZodString;
    initiative: z.ZodString;
    statement: z.ZodString;
}, z.core.$strict>;
type OutOfScope = z.infer<typeof OutOfScopeSchema>;

export { type Bet as B, type Freeze as F, type OutOfScope as O, type Prediction as P, BetSchema as a, type FreezeEndCondition as b, FreezeEndConditionSchema as c, FreezeSchema as d, OutOfScopeSchema as e, type Outcome as f, OutcomeSchema as g, type OwnerIntentRef as h, OwnerIntentRefSchema as i, PredictionSchema as j };
