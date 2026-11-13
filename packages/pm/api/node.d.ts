import { ZodType } from 'zod';
import { f as Outcome, B as Bet, F as Freeze, O as OutOfScope } from './planning.js';

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

export { type PlanKind, type PlanRecords, PlanStoreError, type PlanStoreErrorKind, loadPlanRecords, nextPlanId, planLabel, planSchema, readPlanRecord, withPlanLock, writePlanRecord };

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
