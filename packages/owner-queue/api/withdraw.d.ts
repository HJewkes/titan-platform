import { z } from 'zod';
import { O as OwnerItem } from './schema.js';

declare const WITHDRAW_LOG = "withdrawals.jsonl";
/** `superseded:<id>` names the item that replaces this one. */
declare const WITHDRAW_REASON: RegExp;
declare const withdrawalSchema: z.ZodObject<{
    reason: z.ZodString;
    by: z.ZodString;
    actor: z.ZodOptional<z.ZodString>;
    at: z.ZodISODateTime;
}, z.core.$strict>;
type Withdrawal = z.infer<typeof withdrawalSchema>;
/** `unknown`: no deposit has this id. `refused`: a bad reason, or the id is not a deposit, not this asker's, or answered. */
declare class WithdrawRefusedError extends Error {
    readonly kind: "unknown" | "refused";
    constructor(message: string, kind: "unknown" | "refused");
}
interface WithdrawRequest {
    reason: string;
    /** Must equal the deposit's asker. */
    as: string;
    /** Who runs the withdraw; recorded beside the asker. */
    actor: string;
    now?: Date;
}
interface RestoreRequest {
    as: string;
    actor: string;
    now?: Date;
}
interface MatchRequest {
    asker: string;
    actor: string;
    /** A deposit matches when it carries any of these keys. */
    keys: readonly string[];
    reason: string;
    now?: Date;
    /** Lists the matches and writes nothing. */
    dryRun?: boolean;
}
type WithdrawResult = {
    id: string;
    outcome: "withdrawn" | "already-withdrawn";
};
type RestoreResult = {
    id: string;
    outcome: "restored" | "not-withdrawn";
};
/** The withdrawal of item `id`, or undefined when none is filed. Throws on a malformed marker. */
declare function readWithdrawal(dir: string, id: string): Promise<Withdrawal | undefined>;
/** Withdraws the deposit `id` that `as` filed; throws WithdrawRefusedError on an unknown id or a refusal. */
declare function withdrawDeposit(dir: string, id: string, { reason, as, actor, now }: WithdrawRequest): Promise<WithdrawResult>;
/** Undoes a withdrawal of the deposit `id` that `as` filed, so it is open again. */
declare function restoreDeposit(dir: string, id: string, { as, actor, now }: RestoreRequest): Promise<RestoreResult>;
/** Every open deposit `asker` filed with one of `keys`, each withdrawn with `reason` unless `dryRun`. */
declare function withdrawMatching(dir: string, { asker, actor, keys, reason, now, dryRun }: MatchRequest): Promise<OwnerItem[]>;

export { type MatchRequest, type RestoreRequest, type RestoreResult, WITHDRAW_LOG, WITHDRAW_REASON, WithdrawRefusedError, type WithdrawRequest, type WithdrawResult, type Withdrawal, readWithdrawal, restoreDeposit, withdrawDeposit, withdrawMatching, withdrawalSchema };

// ./dist/schema.d.ts
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
    op: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"resolve-gate">;
        gateId: z.ZodString;
        headSha: z.ZodString;
        decision: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"release-hold">;
        repo: z.ZodString;
        pr: z.ZodNumber;
        headSha: z.ZodString;
        holdClass: z.ZodEnum<{
            g10: "g10";
            "owner-asked": "owner-asked";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"merge-at-head">;
        repo: z.ZodString;
        pr: z.ZodNumber;
        headSha: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"close-pr">;
        repo: z.ZodString;
        pr: z.ZodNumber;
        headSha: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"factory-config-set">;
        path: z.ZodString;
        value: z.ZodJSONSchema;
        expectFrom: z.ZodOptional<z.ZodJSONSchema>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"deploy-pause-clear">;
        pausedAt: z.ZodISODateTime;
        target: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"retire-agent">;
        name: z.ZodString;
        agentId: z.ZodString;
        force: z.ZodBoolean;
    }, z.core.$strict>], "kind">>;
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
    repeats: z.ZodOptional<z.ZodNumber>;
    lint: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
type SourceRef = z.infer<typeof sourceRefSchema>;
type OwnerItem = z.infer<typeof ownerItemSchema>;
type OwnerAnswer = z.infer<typeof answerSchema>;
type LocatorCite = z.infer<typeof locatorCiteSchema>;
type ItemStatus = (typeof ITEM_STATUSES)[number];
type Audience = (typeof AUDIENCES)[number];
type OnSilence = z.infer<typeof onSilenceSchema>;

export { type Audience as A, DOORS as D, type ItemStatus as I, LENSES as L, type OwnerItem as O, ROUTE_TARGETS as R, type SourceRef as S, type OwnerAnswer as a, AUDIENCES as b, ITEM_KINDS as c, ITEM_STATUSES as d, type LocatorCite as e, ON_SILENCE_ACTIONS as f, type OnSilence as g, SOURCE_SYSTEMS as h, locatorCiteSchema as l, ownerItemSchema as o, sourceRefSchema as s };
