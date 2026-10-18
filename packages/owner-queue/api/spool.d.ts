import { RevisionSource } from '@titan-design/evidence';
import { O as OwnerItem, a as OwnerAnswer, A as Audience, i as OwnerItemDeposit } from './deposit.js';
import 'zod';

/** One anchor that held at its pinned commit, with its first and last lines quoted back. */
interface QuotedAnchor {
    anchor: string;
    first: string;
    last: string;
}
/** Thrown before anything is written, naming each anchor that does not hold at its pinned commit. */
declare class DepositAnchorError extends Error {
    readonly refusals: readonly string[];
    constructor(refusals: readonly string[]);
}

/** One transcript line: `byteLength` bytes at `byteOffset` of the session's transcript. */
interface SessionEventRef {
    session: string;
    byteOffset: number;
    byteLength: number;
}
/** The text of one transcript event, or null when it cannot be read. `@titan-design/session-read`'s readSessionEventText fits. */
type SessionEventTextSource = (ref: SessionEventRef) => Promise<string | null>;
/** Thrown before anything is written, when a locator cite's quote is not checked true against its event. */
declare class DepositCiteError extends Error {
    readonly refusal: string;
    constructor(refusal: string);
}

/** The cap on one deposit file, so a runaway context cannot fill the spool or the console. */
declare const MAX_DEPOSIT_BYTES: number;
type WriteResult = {
    file: string;
    created: boolean;
};
/** `anchors` quotes back each anchor checked against `source`; absent when none were checked. */
type DepositWriteResult = WriteResult & {
    anchors?: QuotedAnchor[];
};
interface WriteDepositOptions {
    /** File text at a pinned commit. With it, a deposit whose anchor does not hold is refused unwritten. */
    source?: RevisionSource;
    /** Transcript event text. A locator cite is refused unwritten unless its quote matches; with no source it is refused. */
    events?: SessionEventTextSource;
}
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
 * Throws on a refused or oversized deposit, and on a name held by a different deposit. With a
 * `source`, an anchor past EOF or on a path that is not a file at its pinned commit throws
 * DepositAnchorError before anything is written. A locator cite whose quote does not match its
 * transcript event, through `events`, throws DepositCiteError before anything is written.
 */
declare function writeDeposit(dir: string, deposit: OwnerItemDeposit, options?: WriteDepositOptions): Promise<DepositWriteResult>;
/**
 * Reads every deposit in the spool as an open OwnerItem, opened at the file's mtime. A bad
 * file lands in `rejects` and never stops the rest; a missing spool reads as empty. With
 * `audience`, only that reader's items are kept (absent counts as owner); rejects are all kept.
 */
declare function readSpool(dir: string, options?: {
    audience?: Audience;
}): Promise<SpoolContents>;
/** Records the owner's answer to item `id` once; a second answer, under either name, leaves the first in place. */
declare function writeAnswer(dir: string, id: string, answer: OwnerAnswer): Promise<WriteResult>;
/** Returns the answer to item `id`, or undefined if none is filed. Throws on a malformed answer. */
declare function readAnswer(dir: string, id: string): Promise<OwnerAnswer | undefined>;

export { DepositAnchorError, DepositCiteError, type DepositWriteResult, MAX_DEPOSIT_BYTES, type QuotedAnchor, type SessionEventRef, type SessionEventTextSource, type SpoolContents, SpoolNameCollisionError, type SpoolReject, type WriteDepositOptions, type WriteResult, answerFileName, answerFileNames, depositFileName, depositFileNames, readAnswer, readSpool, writeAnswer, writeDeposit };

// ./dist/deposit.d.ts
import { z } from 'zod';

declare const SOURCE_SYSTEMS: readonly ["agent-chat", "hitl", "morning", "active-work", "round", "plan", "deposit"];
declare const ITEM_KINDS: readonly ["decide", "approve", "do", "review", "know"];
declare const DOORS: readonly ["one-way", "two-way"];
declare const LENSES: readonly ["blocking-agent", "blocking-merge", "stuck", "planning", "fyi"];
declare const ROUTE_TARGETS: readonly ["owner-now", "owner-queue", "decider"];
declare const AUDIENCES: readonly ["owner", "operator"];
declare const ITEM_STATUSES: readonly ["open", "answered", "decided", "expired", "gone-elsewhere", "withdrawn"];
declare const ON_SILENCE_ACTIONS: readonly ["wait", "apply-default", "expire"];
declare const onSilenceSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    action: z.ZodLiteral<"wait">;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodEnum<{
        "apply-default": "apply-default";
        expire: "expire";
    }>;
    afterHours: z.ZodNumber;
}, z.core.$strict>], "action">;
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
/**
 * A cite the queue can check: `quote` must appear in one transcript line of `session`, named by
 * `event` as `<byteOffset>:<byteLength>`. A deposit carrying one is refused unless the quote matches.
 */
declare const locatorCiteSchema: z.ZodObject<{
    session: z.ZodString;
    event: z.ZodString;
    quote: z.ZodString;
}, z.core.$strict>;
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
    class: z.ZodOptional<z.ZodString>;
    irreversible: z.ZodOptional<z.ZodString>;
    shown: z.ZodOptional<z.ZodArray<z.ZodString>>;
    default: z.ZodOptional<z.ZodString>;
    onSilence: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        action: z.ZodLiteral<"wait">;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodEnum<{
            "apply-default": "apply-default";
            expire: "expire";
        }>;
        afterHours: z.ZodNumber;
    }, z.core.$strict>], "action">>;
    category: z.ZodOptional<z.ZodString>;
    summary: z.ZodString;
    context: z.ZodString;
    options: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        consequence: z.ZodOptional<z.ZodString>;
        anchors: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    recommended: z.ZodOptional<z.ZodObject<{
        optionId: z.ZodString;
        by: z.ZodString;
        confidence: z.ZodOptional<z.ZodNumber>;
        rationale: z.ZodOptional<z.ZodString>;
        cite: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            session: z.ZodString;
            event: z.ZodString;
            quote: z.ZodString;
        }, z.core.$strict>]>>;
        hidden: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    command: z.ZodOptional<z.ZodString>;
    evidenceRef: z.ZodOptional<z.ZodString>;
    anchors: z.ZodOptional<z.ZodArray<z.ZodString>>;
    pins: z.ZodOptional<z.ZodObject<{
        repo: z.ZodString;
        head: z.ZodString;
        base: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
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
    audience: z.ZodOptional<z.ZodEnum<{
        owner: "owner";
        operator: "operator";
    }>>;
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
type LocatorCite = z.infer<typeof locatorCiteSchema>;
type ItemStatus = (typeof ITEM_STATUSES)[number];
type Audience = (typeof AUDIENCES)[number];
type OnSilence = z.infer<typeof onSilenceSchema>;

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
    class: z.ZodOptional<z.ZodString>;
    irreversible: z.ZodOptional<z.ZodString>;
    shown: z.ZodOptional<z.ZodArray<z.ZodString>>;
    default: z.ZodOptional<z.ZodString>;
    onSilence: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        action: z.ZodLiteral<"wait">;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodEnum<{
            "apply-default": "apply-default";
            expire: "expire";
        }>;
        afterHours: z.ZodNumber;
    }, z.core.$strict>], "action">>;
    summary: z.ZodString;
    context: z.ZodString;
    options: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        consequence: z.ZodOptional<z.ZodString>;
        anchors: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>;
    recommended: z.ZodOptional<z.ZodObject<{
        optionId: z.ZodString;
        by: z.ZodString;
        confidence: z.ZodOptional<z.ZodNumber>;
        rationale: z.ZodOptional<z.ZodString>;
        cite: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            session: z.ZodString;
            event: z.ZodString;
            quote: z.ZodString;
        }, z.core.$strict>]>>;
    }, z.core.$strict>>;
    command: z.ZodOptional<z.ZodString>;
    evidenceRef: z.ZodOptional<z.ZodString>;
    anchors: z.ZodOptional<z.ZodArray<z.ZodString>>;
    pins: z.ZodOptional<z.ZodObject<{
        repo: z.ZodString;
        head: z.ZodString;
        base: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    keys: z.ZodDefault<z.ZodArray<z.ZodString>>;
    seat: z.ZodOptional<z.ZodString>;
    initiative: z.ZodOptional<z.ZodString>;
    personal: z.ZodDefault<z.ZodBoolean>;
    unblocks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    audience: z.ZodOptional<z.ZodEnum<{
        owner: "owner";
        operator: "operator";
    }>>;
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

export { type Audience as A, DEPOSIT_LENS as D, type ItemStatus as I, LENSES as L, type OwnerItem as O, ROUTE_TARGETS as R, type SourceRef as S, type OwnerAnswer as a, AUDIENCES as b, DOORS as c, ITEM_KINDS as d, ITEM_STATUSES as e, type LocatorCite as f, ON_SILENCE_ACTIONS as g, type OnSilence as h, type OwnerItemDeposit as i, SOURCE_SYSTEMS as j, depositItemId as k, fromDeposit as l, locatorCiteSchema as m, ownerItemSchema as n, ownerItemDepositSchema as o, sourceRefSchema as s };
