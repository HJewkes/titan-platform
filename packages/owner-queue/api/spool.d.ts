import { O as OwnerItem, a as OwnerAnswer, e as OwnerItemDeposit } from './deposit.js';
import 'zod';

/** The cap on one deposit file, so a runaway context cannot fill the spool or the console. */
declare const MAX_DEPOSIT_BYTES: number;
type WriteResult = {
    file: string;
    created: boolean;
};
type SpoolReject = {
    file: string;
    reason: string;
};
type SpoolContents = {
    items: OwnerItem[];
    rejects: SpoolReject[];
};
/** Thrown when a spool name is already held by a different deposit, rather than claim it was filed. */
declare class SpoolNameCollisionError extends Error {
    readonly file: string;
    constructor(file: string);
}
/** The deposit's file name: `<asker>-<depositId>.json`, each part encoded so "-" stays a separator. */
declare function depositFileName(asker: string, depositId: string): string;
/** The answer's file name: `<id>.answer.json` beside the deposit, with the item id encoded. */
declare function answerFileName(id: string): string;
/**
 * Every name this deposit may already be filed under: the current name, then the name a spool
 * written before A-Z was escaped gave it, when that differs. Readers accept both; writers only
 * ever create the current one.
 */
declare function depositFileNames(asker: string, depositId: string): string[];
/** Every name an answer to `id` may already be filed under, current name first. */
declare function answerFileNames(id: string): string[];
/**
 * Validates a deposit and files it once. A repeat of the same asker and depositId, under its
 * current or its legacy name, leaves the first file in place and returns `created: false`.
 * Throws on a refused or oversized deposit, and on a name held by a different deposit.
 */
declare function writeDeposit(dir: string, deposit: OwnerItemDeposit): Promise<WriteResult>;
/**
 * Reads every deposit in the spool as an open OwnerItem, opened at the file's mtime. A bad
 * file lands in `rejects` and never stops the rest; a missing spool reads as empty.
 */
declare function readSpool(dir: string): Promise<SpoolContents>;
/** Records the owner's answer to item `id` once; a second answer, under either name, leaves the first in place. */
declare function writeAnswer(dir: string, id: string, answer: OwnerAnswer): Promise<WriteResult>;
/** Returns the answer to item `id`, or undefined if none is filed. Throws on a malformed answer. */
declare function readAnswer(dir: string, id: string): Promise<OwnerAnswer | undefined>;

export { MAX_DEPOSIT_BYTES, type SpoolContents, SpoolNameCollisionError, type SpoolReject, type WriteResult, answerFileName, answerFileNames, depositFileName, depositFileNames, readAnswer, readSpool, writeAnswer, writeDeposit };

// ./dist/deposit.d.ts
import { z } from 'zod';

declare const SOURCE_SYSTEMS: readonly ["agent-chat", "hitl", "morning", "active-work", "round", "plan", "deposit"];
declare const ITEM_KINDS: readonly ["decide", "approve", "do", "review", "know"];
declare const DOORS: readonly ["one-way", "two-way"];
declare const LENSES: readonly ["blocking-agent", "blocking-merge", "stuck", "planning", "fyi"];
declare const ROUTE_TARGETS: readonly ["owner-now", "owner-queue", "decider"];
declare const ITEM_STATUSES: readonly ["open", "answered", "decided", "expired", "gone-elsewhere", "withdrawn"];
declare const sourceRefSchema: z.ZodObject<{
    system: z.ZodEnum<{
        "agent-chat": "agent-chat";
        hitl: "hitl";
        morning: "morning";
        "active-work": "active-work";
        round: "round";
        plan: "plan";
        deposit: "deposit";
    }>;
    ref: z.ZodString;
}, z.core.$strip>;
declare const answerSchema: z.ZodObject<{
    optionId: z.ZodOptional<z.ZodString>;
    optionIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    text: z.ZodOptional<z.ZodString>;
    changeRequested: z.ZodOptional<z.ZodLiteral<true>>;
    variantComments: z.ZodOptional<z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        comment: z.ZodString;
    }, z.core.$strip>>>;
    by: z.ZodObject<{
        class: z.ZodString;
        id: z.ZodString;
        channel: z.ZodString;
    }, z.core.$strip>;
    at: z.ZodISODateTime;
    covers: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
declare const ownerItemSchema: z.ZodObject<{
    id: z.ZodString;
    sources: z.ZodArray<z.ZodObject<{
        system: z.ZodEnum<{
            "agent-chat": "agent-chat";
            hitl: "hitl";
            morning: "morning";
            "active-work": "active-work";
            round: "round";
            plan: "plan";
            deposit: "deposit";
        }>;
        ref: z.ZodString;
    }, z.core.$strip>>;
    kind: z.ZodEnum<{
        decide: "decide";
        approve: "approve";
        do: "do";
        review: "review";
        know: "know";
    }>;
    door: z.ZodEnum<{
        "one-way": "one-way";
        "two-way": "two-way";
    }>;
    category: z.ZodOptional<z.ZodString>;
    summary: z.ZodString;
    context: z.ZodString;
    options: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    recommended: z.ZodOptional<z.ZodObject<{
        optionId: z.ZodString;
        by: z.ZodString;
        confidence: z.ZodOptional<z.ZodNumber>;
        rationale: z.ZodOptional<z.ZodString>;
        cite: z.ZodOptional<z.ZodString>;
        hidden: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    command: z.ZodOptional<z.ZodString>;
    evidenceRef: z.ZodOptional<z.ZodString>;
    keys: z.ZodArray<z.ZodString>;
    asker: z.ZodOptional<z.ZodString>;
    seat: z.ZodOptional<z.ZodString>;
    initiative: z.ZodOptional<z.ZodString>;
    personal: z.ZodBoolean;
    lens: z.ZodEnum<{
        "blocking-agent": "blocking-agent";
        "blocking-merge": "blocking-merge";
        stuck: "stuck";
        planning: "planning";
        fyi: "fyi";
    }>;
    stuckKind: z.ZodOptional<z.ZodString>;
    unblocks: z.ZodArray<z.ZodString>;
    route: z.ZodOptional<z.ZodObject<{
        target: z.ZodEnum<{
            "owner-now": "owner-now";
            "owner-queue": "owner-queue";
            decider: "decider";
        }>;
        reason: z.ZodString;
        shadow: z.ZodBoolean;
    }, z.core.$strip>>;
    authority: z.ZodOptional<z.ZodObject<{
        table: z.ZodString;
        ruleId: z.ZodString;
        resolvers: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    openedAt: z.ZodISODateTime;
    expiresAt: z.ZodOptional<z.ZodISODateTime>;
    status: z.ZodEnum<{
        open: "open";
        answered: "answered";
        decided: "decided";
        expired: "expired";
        "gone-elsewhere": "gone-elsewhere";
        withdrawn: "withdrawn";
    }>;
    answer: z.ZodOptional<z.ZodObject<{
        optionId: z.ZodOptional<z.ZodString>;
        optionIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        text: z.ZodOptional<z.ZodString>;
        changeRequested: z.ZodOptional<z.ZodLiteral<true>>;
        variantComments: z.ZodOptional<z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            comment: z.ZodString;
        }, z.core.$strip>>>;
        by: z.ZodObject<{
            class: z.ZodString;
            id: z.ZodString;
            channel: z.ZodString;
        }, z.core.$strip>;
        at: z.ZodISODateTime;
        covers: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    lint: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
type SourceRef = z.infer<typeof sourceRefSchema>;
type OwnerItem = z.infer<typeof ownerItemSchema>;
type OwnerAnswer = z.infer<typeof answerSchema>;
type ItemStatus = (typeof ITEM_STATUSES)[number];

/**
 * What an agent may file into the owner inbox. Strict at every level, so a deposit that tries
 * to set a system field (id, status, answer, route, authority, lint, a hidden pick) is refused
 * rather than silently stripped.
 */
declare const ownerItemDepositSchema: z.ZodObject<{
    depositId: z.ZodString;
    asker: z.ZodString;
    kind: z.ZodEnum<{
        decide: "decide";
        approve: "approve";
        do: "do";
        review: "review";
        know: "know";
    }>;
    door: z.ZodEnum<{
        "one-way": "one-way";
        "two-way": "two-way";
    }>;
    summary: z.ZodString;
    context: z.ZodString;
    options: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    recommended: z.ZodOptional<z.ZodObject<{
        optionId: z.ZodString;
        by: z.ZodString;
        confidence: z.ZodOptional<z.ZodNumber>;
        rationale: z.ZodOptional<z.ZodString>;
        cite: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    command: z.ZodOptional<z.ZodString>;
    evidenceRef: z.ZodOptional<z.ZodString>;
    keys: z.ZodDefault<z.ZodArray<z.ZodString>>;
    seat: z.ZodOptional<z.ZodString>;
    initiative: z.ZodOptional<z.ZodString>;
    personal: z.ZodDefault<z.ZodBoolean>;
    unblocks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    expiresAt: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strict>;
type OwnerItemDeposit = z.input<typeof ownerItemDepositSchema>;
/** Every deposit has an asker waiting on it, so only Know items leave the blocking lens. */
declare const DEPOSIT_LENS: {
    readonly decide: "blocking-agent";
    readonly approve: "blocking-agent";
    readonly do: "blocking-agent";
    readonly review: "planning";
    readonly know: "fyi";
};
/** The JSON pair keeps the input injective, so an asker containing "/" cannot collide with another. */
declare function depositItemId(asker: string, depositId: string): string;
/** Parses an untrusted deposit and returns the open OwnerItem it files; throws on a refused deposit. */
declare function fromDeposit(deposit: OwnerItemDeposit, now: Date): OwnerItem;

export { DEPOSIT_LENS as D, type ItemStatus as I, LENSES as L, type OwnerItem as O, ROUTE_TARGETS as R, type SourceRef as S, type OwnerAnswer as a, DOORS as b, ITEM_KINDS as c, ITEM_STATUSES as d, type OwnerItemDeposit as e, SOURCE_SYSTEMS as f, depositItemId as g, fromDeposit as h, ownerItemSchema as i, ownerItemDepositSchema as o, sourceRefSchema as s };
