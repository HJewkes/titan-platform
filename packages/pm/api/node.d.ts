import { ZodType } from 'zod';
import { f as Outcome, B as Bet, F as Freeze, O as OutOfScope, T as Task } from './planning.js';

type PlanStoreErrorKind = "invalid" | "not-found" | "lock-timeout";
/** A plan-store refusal the host maps onto its own error kinds; `kind` says which. */
declare class PlanStoreError extends Error {
    readonly kind: PlanStoreErrorKind;
    constructor(kind: PlanStoreErrorKind, message: string, options?: {
        cause?: unknown;
    });
}

/**
 * Serialises read-modify-write on one initiative's plan folder through `<initiative>/plan/.lock`, the lock every
 * plan writer takes, so a console-applied write and a CLI write never interleave. The initiative folder must exist.
 */
declare function withPlanLock<T>(activeRoot: string, initiative: string, fn: () => Promise<T>): Promise<T>;

interface PlanRecords {
    outcome: Outcome;
    bet: Bet;
    freeze: Freeze;
    "out-of-scope": OutOfScope;
}
type PlanKind = keyof PlanRecords;
declare function planSchema<K extends PlanKind>(kind: K): ZodType<PlanRecords[K]>;
declare function planLabel(kind: PlanKind): string;
/** Every record of one kind in one initiative, in filename order; a missing folder holds none. */
declare function loadPlanRecords<K extends PlanKind>(activeRoot: string, initiative: string, kind: K): Promise<PlanRecords[K][]>;
/** The record the id names, or null when the id is malformed or no such file exists; a file that fails its schema throws. */
declare function readPlanRecord<K extends PlanKind>(activeRoot: string, kind: K, id: string): Promise<PlanRecords[K] | null>;
/** Validates the record before any disk write, then writes it atomically to the file its id names. */
declare function writePlanRecord<K extends PlanKind>(activeRoot: string, kind: K, record: PlanRecords[K]): Promise<PlanRecords[K]>;
/** The next free `<initiative>/<letter><n>` id, one above the highest number in use. */
declare function nextPlanId(initiative: string, letter: string, records: readonly {
    id: string;
}[]): string;

interface TaskFileRow {
    initiative: string;
    /** Posix path relative to activeRoot: `<slug>/tasks/<name>` or `<slug>/tasks/archive/<name>`. */
    file: string;
    archived: boolean;
    mtimeMs: number;
    task: Task;
}
interface UnparsedTaskFile {
    initiative: string;
    file: string;
    reason: string;
}
interface InitiativeTasks {
    tasks: TaskFileRow[];
    unparsed: UnparsedTaskFile[];
    missing: boolean;
}
/**
 * Every task file of one initiative, sorted by filename, live rows first and then `tasks/archive/` rows when
 * `archive` is set. A file that fails YAML or the schema lands in `unparsed`; a missing `tasks/` gives
 * `missing: true`; any other directory error throws. Repeated ids are all returned.
 */
declare function readInitiativeTasks(activeRoot: string, slug: string, options?: {
    archive?: boolean;
}): Promise<InitiativeTasks>;

export { type InitiativeTasks, type PlanKind, type PlanRecords, PlanStoreError, type PlanStoreErrorKind, type TaskFileRow, type UnparsedTaskFile, loadPlanRecords, nextPlanId, planLabel, planSchema, readInitiativeTasks, readPlanRecord, withPlanLock, writePlanRecord };

// ./dist/planning.d.ts
import { z } from 'zod';

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

export { type Bet as B, DELIVERABLE_ID_REGEX as D, type Freeze as F, type OutOfScope as O, type Prediction as P, type Task as T, BetSchema as a, type FreezeEndCondition as b, FreezeEndConditionSchema as c, FreezeSchema as d, OutOfScopeSchema as e, type Outcome as f, OutcomeSchema as g, type OwnerIntentRef as h, OwnerIntentRefSchema as i, PredictionSchema as j, TaskSchema as k };
