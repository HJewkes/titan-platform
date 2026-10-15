import { O as OwnerItem, A as Audience, I as ItemStatus, S as SourceRef, a as OwnerAnswer } from './deposit.js';
export { b as AUDIENCES, D as DEPOSIT_LENS, c as DOORS, d as ITEM_KINDS, e as ITEM_STATUSES, L as LENSES, f as ON_SILENCE_ACTIONS, g as OnSilence, h as OwnerItemDeposit, R as ROUTE_TARGETS, i as SOURCE_SYSTEMS, j as depositItemId, k as fromDeposit, o as ownerItemDepositSchema, l as ownerItemSchema, s as sourceRefSchema } from './deposit.js';
import * as zod_v4_core from 'zod/v4/core';
import * as zod from 'zod';
import { z } from 'zod';
import { ManifestInput, FeedbackSchema } from '@titan-design/review-schema';

declare const CARD_RULES: readonly ["card:options", "card:consequence", "card:class", "card:on-silence", "card:default-not-option", "card:apply-default-needs-default", "card:one-way-irreversible", "card:one-way-waits"];
type CardRule = (typeof CARD_RULES)[number];
/**
 * The card rules an item breaks, in `CARD_RULES` order. A one-way decision must say what it
 * cannot undo and must wait on silence, because nothing irreversible may happen by default.
 */
declare function cardLint(item: OwnerItem): CardRule[];
/** An OwnerItem that also passes every card rule; each broken rule is one issue named by its id. */
declare const ownerCardSchema: zod.ZodObject<{
    id: zod.ZodString;
    sources: zod.ZodArray<zod.ZodObject<{
        system: zod.ZodEnum<{
            "agent-chat": "agent-chat";
            hitl: "hitl";
            morning: "morning";
            "active-work": "active-work";
            round: "round";
            plan: "plan";
            deposit: "deposit";
        }>;
        ref: zod.ZodString;
    }, zod_v4_core.$strip>>;
    kind: zod.ZodEnum<{
        decide: "decide";
        approve: "approve";
        do: "do";
        review: "review";
        know: "know";
    }>;
    door: zod.ZodEnum<{
        "one-way": "one-way";
        "two-way": "two-way";
    }>;
    class: zod.ZodOptional<zod.ZodString>;
    irreversible: zod.ZodOptional<zod.ZodString>;
    shown: zod.ZodOptional<zod.ZodArray<zod.ZodString>>;
    default: zod.ZodOptional<zod.ZodString>;
    onSilence: zod.ZodOptional<zod.ZodDiscriminatedUnion<[zod.ZodObject<{
        action: zod.ZodLiteral<"wait">;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        action: zod.ZodEnum<{
            "apply-default": "apply-default";
            expire: "expire";
        }>;
        afterHours: zod.ZodNumber;
    }, zod_v4_core.$strict>], "action">>;
    category: zod.ZodOptional<zod.ZodString>;
    summary: zod.ZodString;
    context: zod.ZodString;
    options: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
        id: zod.ZodString;
        label: zod.ZodString;
        description: zod.ZodOptional<zod.ZodString>;
        consequence: zod.ZodOptional<zod.ZodString>;
        anchors: zod.ZodOptional<zod.ZodArray<zod.ZodString>>;
    }, zod_v4_core.$strip>>>;
    recommended: zod.ZodOptional<zod.ZodObject<{
        optionId: zod.ZodString;
        by: zod.ZodString;
        confidence: zod.ZodOptional<zod.ZodNumber>;
        rationale: zod.ZodOptional<zod.ZodString>;
        cite: zod.ZodOptional<zod.ZodString>;
        hidden: zod.ZodOptional<zod.ZodBoolean>;
    }, zod_v4_core.$strip>>;
    command: zod.ZodOptional<zod.ZodString>;
    evidenceRef: zod.ZodOptional<zod.ZodString>;
    anchors: zod.ZodOptional<zod.ZodArray<zod.ZodString>>;
    pins: zod.ZodOptional<zod.ZodObject<{
        repo: zod.ZodString;
        head: zod.ZodString;
        base: zod.ZodOptional<zod.ZodString>;
    }, zod_v4_core.$strict>>;
    keys: zod.ZodArray<zod.ZodString>;
    asker: zod.ZodOptional<zod.ZodString>;
    seat: zod.ZodOptional<zod.ZodString>;
    initiative: zod.ZodOptional<zod.ZodString>;
    personal: zod.ZodBoolean;
    lens: zod.ZodEnum<{
        "blocking-agent": "blocking-agent";
        "blocking-merge": "blocking-merge";
        stuck: "stuck";
        planning: "planning";
        fyi: "fyi";
    }>;
    stuckKind: zod.ZodOptional<zod.ZodString>;
    unblocks: zod.ZodArray<zod.ZodString>;
    audience: zod.ZodOptional<zod.ZodEnum<{
        owner: "owner";
        operator: "operator";
    }>>;
    route: zod.ZodOptional<zod.ZodObject<{
        target: zod.ZodEnum<{
            "owner-now": "owner-now";
            "owner-queue": "owner-queue";
            decider: "decider";
        }>;
        reason: zod.ZodString;
        shadow: zod.ZodBoolean;
    }, zod_v4_core.$strip>>;
    authority: zod.ZodOptional<zod.ZodObject<{
        table: zod.ZodString;
        ruleId: zod.ZodString;
        resolvers: zod.ZodArray<zod.ZodString>;
    }, zod_v4_core.$strip>>;
    openedAt: zod.ZodISODateTime;
    expiresAt: zod.ZodOptional<zod.ZodISODateTime>;
    status: zod.ZodEnum<{
        open: "open";
        answered: "answered";
        decided: "decided";
        expired: "expired";
        "gone-elsewhere": "gone-elsewhere";
        withdrawn: "withdrawn";
    }>;
    answer: zod.ZodOptional<zod.ZodObject<{
        optionId: zod.ZodOptional<zod.ZodString>;
        optionIds: zod.ZodOptional<zod.ZodArray<zod.ZodString>>;
        text: zod.ZodOptional<zod.ZodString>;
        changeRequested: zod.ZodOptional<zod.ZodLiteral<true>>;
        variantComments: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
            key: zod.ZodString;
            comment: zod.ZodString;
        }, zod_v4_core.$strip>>>;
        by: zod.ZodObject<{
            class: zod.ZodString;
            id: zod.ZodString;
            channel: zod.ZodString;
        }, zod_v4_core.$strip>;
        at: zod.ZodISODateTime;
        covers: zod.ZodOptional<zod.ZodNumber>;
    }, zod_v4_core.$strip>>;
    lint: zod.ZodOptional<zod.ZodArray<zod.ZodString>>;
}, zod_v4_core.$strip>;

/** Items filed before `audience` existed carry none and stay owner items. */
declare function audienceOf(item: Pick<OwnerItem, "audience">): Audience;
/** Keeps the items for `audience`, in input order. */
declare function forAudience<T extends Pick<OwnerItem, "audience">>(items: readonly T[], audience: Audience): T[];

/**
 * Why A likely changes B: `base` (A is on B's base PR), `pr-decision` (A decides on B's PR),
 * `shared-unit` (A decides or is one-way on B's component or token), `unblocks` (A unblocks B's
 * task, or B's task depends on A's), `topic` (A decides B's topic) and `overlap` (A and B share a
 * merge key but were kept apart by dedupe).
 */
declare const INFLUENCE_RULES: readonly ["base", "pr-decision", "shared-unit", "unblocks", "topic", "overlap"];
type InfluenceRule = (typeof INFLUENCE_RULES)[number];
/** A likely changes B, so B is served after A is answered. */
interface InfluenceEdge {
    from: string;
    to: string;
    rules: InfluenceRule[];
}
interface InfluenceContext {
    /** Item id to the base PRs it is shown against, as `stackContext` returns them. */
    context: ReadonlyMap<string, readonly string[]>;
    /** active-work task id to the task ids it depends on. */
    deps: Readonly<Record<string, readonly string[]>>;
}
/** Every influence edge between distinct items, ordered by `from` then `to` id. */
declare function influenceEdges(items: readonly OwnerItem[], { context, deps }: InfluenceContext): InfluenceEdge[];

type RecheckFlagKind = "conflict" | "reasked" | "related-answer";
/** An earlier answer the owner should see beside an item it did not settle. */
interface RecheckFlag {
    itemId: string;
    kind: RecheckFlagKind;
    answerId: string;
    /** The relation keys the item and the answer share, sorted. */
    keys: string[];
}
/** The answer that settled a dropped item. */
interface RecheckCite {
    answerId: string;
    key: string;
    at: string;
}
interface RecheckDrop {
    /** The item as it was, with status `gone-elsewhere`. */
    item: OwnerItem;
    cite: RecheckCite;
}
interface Recheck {
    open: OwnerItem[];
    dropped: RecheckDrop[];
    flags: RecheckFlag[];
}
/**
 * Re-checks open items against answers already given (rule 2). An item is dropped as
 * `gone-elsewhere`, citing the newest such answer, when an answer sharing its `ask:` key is
 * newer than its `openedAt` and pinned to no other head of a PR the item names. An older or
 * other-head answer on the same `ask:` key flags `conflict` when it is not the item's
 * recommendation and `reasked` when it is or there is none. Sharing only a `component:`,
 * `token:` or `topic:` key flags `related-answer` and never drops. Answers are the items
 * carrying an `answer`; others are ignored. Output is sorted, so input order never changes it.
 */
declare function recheck(open: readonly OwnerItem[], answered: readonly OwnerItem[]): Recheck;

interface WithdrawnItem {
    /** The item relabelled `withdrawn`; an answer it carried is kept, so a change request stays readable. */
    item: OwnerItem;
    /** The status it had before it was withdrawn. */
    was: ItemStatus;
    /** `<owner>/<repo>#<n>`, lower-cased. */
    pr: string;
    /** `new-head:<live sha>`. */
    reason: string;
}
interface Superseded {
    /** Every item not withdrawn, in input order. */
    kept: OwnerItem[];
    withdrawn: WithdrawnItem[];
    /** The live head of each PR any item pins: `heads[pr]` when it is a full sha, else the newest item's. */
    heads: Record<string, string>;
}
/**
 * Rule 1 of the consolidation pass. A PR's live head is `heads[pr]` (keyed `<owner>/<repo>#<n>`,
 * case-insensitively, full sha only), or else the head of its newest pinned item. An open,
 * answered or decided item pinned to any other head is withdrawn as `new-head:<sha>`: approval
 * resets on a new push, so its answer never counts at the live head. An unpinned or short-sha
 * PR key pins nothing and is never withdrawn. Pure: no clock and no I/O.
 */
declare function supersede(items: readonly OwnerItem[], heads?: Readonly<Record<string, string>>): Superseded;
interface StackedItem {
    item: OwnerItem;
    /** The base PRs of the item's stacked PRs, nearest first: shown as context, not under review. */
    context: string[];
}
/**
 * Rule 3 of the consolidation pass. `stacks` maps a stacked PR to its base PR, both
 * `<owner>/<repo>#<n>`, case-insensitively. Each item on a stacked PR gets its base chain as
 * `context` and orders after every item on those bases; other items keep their input order.
 * A cycle in `stacks` falls back to input order for the items it joins. Pure: no clock and no I/O.
 */
declare function stackContext(items: readonly OwnerItem[], stacks: Readonly<Record<string, string>>): StackedItem[];

interface ConsolidateInput {
    /** Items already answered, the feedback.json answers included. */
    answered?: readonly OwnerItem[];
    /** `<owner>/<repo>#<n>` to its live head sha. */
    heads?: Readonly<Record<string, string>>;
    /** A stacked PR to its base PR. */
    stacks?: Readonly<Record<string, string>>;
    /** active-work task id to the task ids it depends on. */
    deps?: Readonly<Record<string, readonly string[]>>;
}
/** `change-requested`, `free-text`, or `other-choice`: a pick that is not the implemented (recommended) one. */
type ShipBlockReason = "change-requested" | "free-text" | "other-choice";
interface ShipBlock {
    itemId: string;
    reason: ShipBlockReason;
    at: string;
}
interface FlowGroup {
    /** `pr:<owner>/<repo>#<n>` for a PR group; a topic group takes its smallest shared key, or `item:<id>`. */
    id: string;
    kind: "pr" | "topic";
    itemIds: string[];
    /** PR groups only: the open change requests at the live head, on any tab. Empty means Ship may go. */
    shipBlockedBy?: ShipBlock[];
}
interface HeldItem {
    itemId: string;
    /** Open items served earlier that likely change this one. */
    waitsOn: string[];
}
interface Flow {
    groups: FlowGroup[];
    order: OwnerItem[];
    held: HeldItem[];
    withdrawn: WithdrawnItem[];
    dropped: RecheckDrop[];
    flags: RecheckFlag[];
    /** Item id to the base PRs it is shown against, for items on a stacked PR. */
    context: Record<string, string[]>;
    edges: InfluenceEdge[];
}
/**
 * Turns the open queue into the Flow the owner reads, steps 1-7 of the consolidation pass:
 * supersede old heads, re-check against answers, dedupe within a class, attach stacked
 * context, group (fixed per PR, topic groups first), order by influence and hold dependents.
 * Pure, and the same output for any input order.
 */
declare function consolidate(open: readonly OwnerItem[], input?: ConsolidateInput): Flow;

type ClosedStatus = Exclude<ItemStatus, "open">;
type SourceEvent = {
    type: "opened";
    item: OwnerItem;
    cursor: string;
} | {
    type: "closed";
    ref: string;
    status: ClosedStatus;
    cursor: string;
}
/** The source lost its place (a gap too large to replay); the reader re-reads open(). */
 | {
    type: "resync";
    cursor: string;
};
type ResolveResult = {
    ok: true;
} | {
    ok: false;
    reason: "closed" | "rejected";
    detail?: string;
};
/** One store of record behind the owner queue. Adapters own all I/O; every item they emit names this source in `sources`. */
interface QueueSource {
    readonly system: SourceRef["system"];
    open(): Promise<OwnerItem[]>;
    /** Events after `cursor` (undefined = from now); ends when `signal` aborts. */
    tail(cursor: string | undefined, signal: AbortSignal): AsyncIterable<SourceEvent>;
    /** `ref` is the source's own SourceRef.ref; the store of record arbitrates, so a second answer loses. */
    resolve(ref: string, answer: OwnerAnswer): Promise<ResolveResult>;
}

/**
 * Relation keys say two items are about the same thing without making them one item, so none of
 * them is a merge key. `ask:` is the same question across rounds; `component:`, `token:` and
 * `topic:` mark a shared component, design token or topic.
 */
declare const RELATION_KEY_KINDS: readonly ["ask", "component", "token", "topic"];
type RelationKeyKind = (typeof RELATION_KEY_KINDS)[number];
declare function askKey(id: string): string;
/** The default ask key of a round question, until question ids are stable per ask across rounds. */
declare function roundAskKey(unit: string, questionId: string): string;
declare function componentKey(name: string): string;
declare function tokenKey(name: string): string;
declare function topicKey(name: string): string;
/** A PR key pinned to its head, in the canonical form `mergeByKeys` compares. */
declare function prKey(repo: string, pr: number, headSha: string): string;
/** The relation kind of a key, or null for a merge key or anything else. */
declare function relationKind(key: string): RelationKeyKind | null;

/** A key merges only in its exact, complete form: a PR ref needs its full 40-hex head sha. */
declare function isMergeKey(key: string): boolean;
/**
 * Merges items from every source that share an exact key, including the head sha of a PR key.
 * Items naming two different heads of one PR stay apart even when another key matches: one
 * answer must never approve a head nobody reviewed. Output keeps the order of each group's first item.
 */
declare function mergeByKeys(items: readonly OwnerItem[]): OwnerItem[];

/**
 * Orders items for the owner: one-way and blocking owner-now items first, then by cost of
 * waiting (how many keys the answer unblocks), then oldest first. Ties group by initiative,
 * then fall back to id so the order never depends on input order.
 */
declare function rank(items: readonly OwnerItem[]): OwnerItem[];

type Recommended = NonNullable<OwnerItem["recommended"]>;
/** The reason several asks would get one answer, written as one rule (TP-1535 rule 3). */
interface Principle {
    id: string;
    /** One sentence: the rule and its limits. The covered items are listed after it. */
    rule: string;
    /** OwnerItem ids. One-way items are asked alone; with fewer than two left the items are asked alone. */
    covers: readonly string[];
    /** `optionId` is "yes" or "no". A hidden one puts the principle in an after-answer round. */
    recommended?: Recommended;
}
interface OwnerRoundOptions {
    unit: string;
    /** A loopback Storybook URL; round@2 requires one even for a questions-only round. */
    storybookUrl: string;
    /** The first round's number; later rounds count up from it. Default 1. */
    firstRound?: number;
    /** Default [1280]. */
    widths?: number[];
    /** Categories graduated from shadow mode, whose recommendations a round shows from the start. */
    graduated?: readonly string[];
    principles?: readonly Principle[];
    /** Questions per round; a principle counts as one. Default 10. */
    maxQuestions?: number;
}
interface RoundQuestionBinding {
    questionId: string;
    /** The item asked, or every item the principle covers. */
    itemIds: string[];
    principleId?: string;
    /** Shown option label to the item's option id ("yes" or "no" for a principle). */
    options: Record<string, string>;
}
interface OwnerRound {
    manifest: ManifestInput;
    bindings: RoundQuestionBinding[];
}
type SkipReason = "invalid" | "not-open" | "not-decide" | "routed-to-decider";
interface OwnerRounds {
    rounds: OwnerRound[];
    skipped: {
        id: string;
        reason: SkipReason;
    }[];
}
/**
 * Turns open Decide items into titan-review/round@2 manifests, one question and one section per
 * ask, in input order (rank first). Items a principle covers become one `Principle:` question.
 * Asks with a shadow-mode item or a hidden pick go in rounds that reveal recommendations after
 * the answer; the rest go in rounds that show them. Pure: no I/O and no clock.
 *
 * Throws a ZodError on invalid options (a non-loopback storybookUrl, bad widths, a maxQuestions
 * or firstRound below 1), and every manifest is parsed with RoundSchema before it is returned.
 */
declare function buildOwnerRounds(items: readonly OwnerItem[], options: OwnerRoundOptions): OwnerRounds;

type FeedbackInput = z.input<typeof FeedbackSchema>;
interface RoundItemsContext {
    /** When the round was served: round@2 carries no time of its own. */
    openedAt: string;
    /** What buildOwnerRounds returned with the manifest, so a question maps back to the item it asked. */
    bindings?: readonly RoundQuestionBinding[];
}
interface AnsweredContext extends RoundItemsContext {
    roundId: string;
}
/** feedback@1 does not say who answered; only the owner answers a round. */
declare const ROUND_ANSWERER: OwnerAnswer["by"];
declare function roundItemId(roundId: string, questionId: string): string;
/**
 * Each round@2 question as an open OwnerItem, in question order. The item carries the question's
 * `ask:` key and, for a merge-bound question, the PR key pinned to its head. Throws when the
 * manifest or `openedAt` is invalid. Pure: no I/O and no clock.
 */
declare function fromRoundQuestions(manifest: ManifestInput, roundId: string, context: RoundItemsContext): OwnerItem[];
/**
 * The answered questions of a feedback@1 file as answered OwnerItems: the same items
 * fromRoundQuestions gives, with the owner's answer at `submittedAt`. With the round's bindings a
 * pick maps back to the option id of the item it asked. Questions left unanswered are omitted,
 * but a revision request is always kept, because it must still block a ship.
 * Throws when either file is invalid or the feedback is for another unit or round.
 */
declare function answeredFromFeedback(feedback: FeedbackInput, manifest: ManifestInput, context: AnsweredContext): OwnerItem[];

declare const STALE_RULES: readonly ["pr-merged", "head-moved", "task-done", "asker-retired"];
type StaleRule = (typeof STALE_RULES)[number];
/** An asker's declared `onNoAnswer` meaning "wait for the owner": nothing was done in their absence. */
declare const PARKED = "parked";
/**
 * Source facts read by the caller, as of one moment. A missing entry is no fact, and no
 * fact never labels an item stale. PRs are keyed `<owner>/<repo>#<n>`, case-insensitively,
 * the same ref consolidate's `heads[pr]` uses.
 */
interface StaleEvidence {
    prs?: Readonly<Record<string, {
        state: "open" | "closed" | "merged";
        head?: string;
    }>>;
    tasks?: Readonly<Record<string, {
        status: string;
    }>>;
    askers?: Readonly<Record<string, {
        retired: boolean;
    }>>;
    /** Item id to the `onNoAnswer` its asker declared at the source; absent when none was declared. */
    onNoAnswer?: Readonly<Record<string, string>>;
}
interface StaleLabel {
    status: "gone-elsewhere";
    rule: StaleRule;
    /** `pr-merged:<pr>`, `new-head:<sha>`, `task-done:<id>` or `asker-retired:<asker>`. */
    reason: string;
}
/**
 * Labels an open item stale when its sources' own facts say the question is gone, or
 * returns null. Rules run in `STALE_RULES` order and the first match wins: a merged PR
 * outranks the head it moved to. A closed item is never relabelled.
 */
declare function staleLabel(item: OwnerItem, evidence: StaleEvidence): StaleLabel | null;

export { type AnsweredContext, Audience, CARD_RULES, type CardRule, type ClosedStatus, type ConsolidateInput, type FeedbackInput, type Flow, type FlowGroup, type HeldItem, INFLUENCE_RULES, type InfluenceContext, type InfluenceEdge, type InfluenceRule, ItemStatus, OwnerAnswer, OwnerItem, type OwnerRound, type OwnerRoundOptions, type OwnerRounds, PARKED, type Principle, type QueueSource, RELATION_KEY_KINDS, ROUND_ANSWERER, type Recheck, type RecheckCite, type RecheckDrop, type RecheckFlag, type RecheckFlagKind, type RelationKeyKind, type ResolveResult, type RoundItemsContext, type RoundQuestionBinding, STALE_RULES, type ShipBlock, type ShipBlockReason, type SkipReason, type SourceEvent, SourceRef, type StackedItem, type StaleEvidence, type StaleLabel, type StaleRule, type Superseded, type WithdrawnItem, answeredFromFeedback, askKey, audienceOf, buildOwnerRounds, cardLint, componentKey, consolidate, forAudience, fromRoundQuestions, influenceEdges, isMergeKey, mergeByKeys, ownerCardSchema, prKey, rank, recheck, relationKind, roundAskKey, roundItemId, stackContext, staleLabel, supersede, tokenKey, topicKey };

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
        cite: z.ZodOptional<z.ZodString>;
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
        cite: z.ZodOptional<z.ZodString>;
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

export { type Audience as A, DEPOSIT_LENS as D, type ItemStatus as I, LENSES as L, type OwnerItem as O, ROUTE_TARGETS as R, type SourceRef as S, type OwnerAnswer as a, AUDIENCES as b, DOORS as c, ITEM_KINDS as d, ITEM_STATUSES as e, ON_SILENCE_ACTIONS as f, type OnSilence as g, type OwnerItemDeposit as h, SOURCE_SYSTEMS as i, depositItemId as j, fromDeposit as k, ownerItemSchema as l, ownerItemDepositSchema as o, sourceRefSchema as s };
