import { O as OwnerItem, A as Audience, a as OnSilence, I as ItemStatus, S as SourceRef, b as OwnerAnswer } from './schema.js';
export { c as AUDIENCES, D as DOORS, d as ITEM_KINDS, e as ITEM_STATUSES, L as LENSES, f as LocatorCite, g as ON_SILENCE_ACTIONS, R as ROUTE_TARGETS, h as SOURCE_SYSTEMS, i as SittingStep, j as StepOutcome, l as locatorCiteSchema, o as ownerItemSchema, s as sourceRefSchema } from './schema.js';
import * as zod_v4_core from 'zod/v4/core';
import * as zod from 'zod';
import { z } from 'zod';
export { D as DEPOSIT_LENS, O as OwnerItemDeposit, d as depositItemId, f as fromDeposit, o as ownerItemDepositSchema } from './deposit.js';
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
            "active-work": "active-work";
            "agent-chat": "agent-chat";
            deposit: "deposit";
            hitl: "hitl";
            morning: "morning";
            plan: "plan";
            round: "round";
        }>;
        ref: zod.ZodString;
    }, zod_v4_core.$strip>>;
    kind: zod.ZodEnum<{
        approve: "approve";
        decide: "decide";
        do: "do";
        know: "know";
        review: "review";
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
        cite: zod.ZodOptional<zod.ZodUnion<readonly [zod.ZodString, zod.ZodObject<{
            session: zod.ZodString;
            event: zod.ZodString;
            quote: zod.ZodString;
        }, zod_v4_core.$strict>]>>;
        hidden: zod.ZodOptional<zod.ZodBoolean>;
    }, zod_v4_core.$strip>>;
    command: zod.ZodOptional<zod.ZodString>;
    op: zod.ZodOptional<zod.ZodDiscriminatedUnion<[zod.ZodObject<{
        kind: zod.ZodLiteral<"resolve-gate">;
        gateId: zod.ZodString;
        headSha: zod.ZodString;
        decision: zod.ZodString;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        kind: zod.ZodLiteral<"release-hold">;
        repo: zod.ZodString;
        pr: zod.ZodNumber;
        headSha: zod.ZodString;
        holdClass: zod.ZodEnum<{
            g10: "g10";
            "owner-asked": "owner-asked";
        }>;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        kind: zod.ZodLiteral<"merge-at-head">;
        repo: zod.ZodString;
        pr: zod.ZodNumber;
        headSha: zod.ZodString;
        waitFor: zod.ZodOptional<zod.ZodEnum<{
            "adversary-loop": "adversary-loop";
        }>>;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        kind: zod.ZodLiteral<"close-pr">;
        repo: zod.ZodString;
        pr: zod.ZodNumber;
        headSha: zod.ZodString;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        kind: zod.ZodLiteral<"delete-branch">;
        repo: zod.ZodString;
        branch: zod.ZodString;
        tipSha: zod.ZodString;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        kind: zod.ZodLiteral<"factory-config-set">;
        path: zod.ZodString;
        value: zod.ZodJSONSchema;
        expectFrom: zod.ZodOptional<zod.ZodJSONSchema>;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        kind: zod.ZodLiteral<"deploy-pause-clear">;
        pausedAt: zod.ZodISODateTime;
        target: zod.ZodString;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        kind: zod.ZodLiteral<"retire-agent">;
        name: zod.ZodString;
        agentId: zod.ZodString;
        force: zod.ZodBoolean;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        kind: zod.ZodLiteral<"plan-bet-select">;
        initiative: zod.ZodString;
        week: zod.ZodString;
        bets: zod.ZodArray<zod.ZodString>;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        kind: zod.ZodLiteral<"plan-outcome-edit">;
        outcome: zod.ZodString;
        to: zod.ZodObject<{
            statement: zod.ZodOptional<zod.ZodString>;
            measure: zod.ZodOptional<zod.ZodString>;
        }, zod_v4_core.$strict>;
        from: zod.ZodOptional<zod.ZodObject<{
            statement: zod.ZodString;
            measure: zod.ZodString;
        }, zod_v4_core.$strict>>;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        kind: zod.ZodLiteral<"plan-freeze-set">;
        initiative: zod.ZodString;
        freeze: zod.ZodDiscriminatedUnion<[zod.ZodObject<{
            intent_ref: zod.ZodString;
            quote_ref: zod.ZodString;
            action: zod.ZodLiteral<"set">;
            tag: zod.ZodOptional<zod.ZodString>;
            selector: zod.ZodOptional<zod.ZodString>;
            reason: zod.ZodString;
            end_condition: zod.ZodDiscriminatedUnion<[zod.ZodObject<{
                kind: zod.ZodLiteral<"date">;
                date: zod.ZodString;
            }, zod_v4_core.$strict>, zod.ZodObject<{
                kind: zod.ZodLiteral<"task-done">;
                task: zod.ZodString;
            }, zod_v4_core.$strict>, zod.ZodObject<{
                kind: zod.ZodLiteral<"measure">;
                metric: zod.ZodString;
                direction: zod.ZodEnum<{
                    decrease: "decrease";
                    increase: "increase";
                }>;
                threshold: zod.ZodNumber;
            }, zod_v4_core.$strict>, zod.ZodObject<{
                kind: zod.ZodLiteral<"owner">;
            }, zod_v4_core.$strict>], "kind">;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            action: zod.ZodLiteral<"end">;
            id: zod.ZodString;
        }, zod_v4_core.$strict>], "action">;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        kind: zod.ZodLiteral<"start-session">;
        name: zod.ZodString;
        profile: zod.ZodString;
        host: zod.ZodString;
        account: zod.ZodUnion<readonly [zod.ZodLiteral<"least-used">, zod.ZodString]>;
        cwd: zod.ZodString;
        surface: zod.ZodString;
        remoteControl: zod.ZodBoolean;
        briefPath: zod.ZodString;
        briefSha256: zod.ZodOptional<zod.ZodString>;
    }, zod_v4_core.$strict>, zod.ZodObject<{
        kind: zod.ZodLiteral<"host-command">;
        command: zod.ZodEnum<{
            "broker-restart-window": "broker-restart-window";
        }>;
    }, zod_v4_core.$strict>], "kind">>;
    steps: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
        title: zod.ZodString;
        command: zod.ZodString;
        op: zod.ZodOptional<zod.ZodDiscriminatedUnion<[zod.ZodObject<{
            kind: zod.ZodLiteral<"resolve-gate">;
            gateId: zod.ZodString;
            headSha: zod.ZodString;
            decision: zod.ZodString;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            kind: zod.ZodLiteral<"release-hold">;
            repo: zod.ZodString;
            pr: zod.ZodNumber;
            headSha: zod.ZodString;
            holdClass: zod.ZodEnum<{
                g10: "g10";
                "owner-asked": "owner-asked";
            }>;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            kind: zod.ZodLiteral<"merge-at-head">;
            repo: zod.ZodString;
            pr: zod.ZodNumber;
            headSha: zod.ZodString;
            waitFor: zod.ZodOptional<zod.ZodEnum<{
                "adversary-loop": "adversary-loop";
            }>>;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            kind: zod.ZodLiteral<"close-pr">;
            repo: zod.ZodString;
            pr: zod.ZodNumber;
            headSha: zod.ZodString;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            kind: zod.ZodLiteral<"delete-branch">;
            repo: zod.ZodString;
            branch: zod.ZodString;
            tipSha: zod.ZodString;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            kind: zod.ZodLiteral<"factory-config-set">;
            path: zod.ZodString;
            value: zod.ZodJSONSchema;
            expectFrom: zod.ZodOptional<zod.ZodJSONSchema>;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            kind: zod.ZodLiteral<"deploy-pause-clear">;
            pausedAt: zod.ZodISODateTime;
            target: zod.ZodString;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            kind: zod.ZodLiteral<"retire-agent">;
            name: zod.ZodString;
            agentId: zod.ZodString;
            force: zod.ZodBoolean;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            kind: zod.ZodLiteral<"plan-bet-select">;
            initiative: zod.ZodString;
            week: zod.ZodString;
            bets: zod.ZodArray<zod.ZodString>;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            kind: zod.ZodLiteral<"plan-outcome-edit">;
            outcome: zod.ZodString;
            to: zod.ZodObject<{
                statement: zod.ZodOptional<zod.ZodString>;
                measure: zod.ZodOptional<zod.ZodString>;
            }, zod_v4_core.$strict>;
            from: zod.ZodOptional<zod.ZodObject<{
                statement: zod.ZodString;
                measure: zod.ZodString;
            }, zod_v4_core.$strict>>;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            kind: zod.ZodLiteral<"plan-freeze-set">;
            initiative: zod.ZodString;
            freeze: zod.ZodDiscriminatedUnion<[zod.ZodObject<{
                intent_ref: zod.ZodString;
                quote_ref: zod.ZodString;
                action: zod.ZodLiteral<"set">;
                tag: zod.ZodOptional<zod.ZodString>;
                selector: zod.ZodOptional<zod.ZodString>;
                reason: zod.ZodString;
                end_condition: zod.ZodDiscriminatedUnion<[zod.ZodObject<{
                    kind: zod.ZodLiteral<"date">;
                    date: zod.ZodString;
                }, zod_v4_core.$strict>, zod.ZodObject<{
                    kind: zod.ZodLiteral<"task-done">;
                    task: zod.ZodString;
                }, zod_v4_core.$strict>, zod.ZodObject<{
                    kind: zod.ZodLiteral<"measure">;
                    metric: zod.ZodString;
                    direction: zod.ZodEnum<{
                        decrease: "decrease";
                        increase: "increase";
                    }>;
                    threshold: zod.ZodNumber;
                }, zod_v4_core.$strict>, zod.ZodObject<{
                    kind: zod.ZodLiteral<"owner">;
                }, zod_v4_core.$strict>], "kind">;
            }, zod_v4_core.$strict>, zod.ZodObject<{
                action: zod.ZodLiteral<"end">;
                id: zod.ZodString;
            }, zod_v4_core.$strict>], "action">;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            kind: zod.ZodLiteral<"start-session">;
            name: zod.ZodString;
            profile: zod.ZodString;
            host: zod.ZodString;
            account: zod.ZodUnion<readonly [zod.ZodLiteral<"least-used">, zod.ZodString]>;
            cwd: zod.ZodString;
            surface: zod.ZodString;
            remoteControl: zod.ZodBoolean;
            briefPath: zod.ZodString;
            briefSha256: zod.ZodOptional<zod.ZodString>;
        }, zod_v4_core.$strict>, zod.ZodObject<{
            kind: zod.ZodLiteral<"host-command">;
            command: zod.ZodEnum<{
                "broker-restart-window": "broker-restart-window";
            }>;
        }, zod_v4_core.$strict>], "kind">>;
        verify: zod.ZodOptional<zod.ZodString>;
        outcome: zod.ZodOptional<zod.ZodEnum<{
            done: "done";
            skipped: "skipped";
        }>>;
    }, zod_v4_core.$strict>>>;
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
        fyi: "fyi";
        planning: "planning";
        stuck: "stuck";
    }>;
    stuckKind: zod.ZodOptional<zod.ZodString>;
    unblocks: zod.ZodArray<zod.ZodString>;
    unblocksNow: zod.ZodOptional<zod.ZodString>;
    blocker: zod.ZodOptional<zod.ZodObject<{
        since: zod.ZodISODateTime;
        blocks: zod.ZodString;
    }, zod_v4_core.$strict>>;
    audience: zod.ZodOptional<zod.ZodEnum<{
        operator: "operator";
        owner: "owner";
    }>>;
    route: zod.ZodOptional<zod.ZodObject<{
        target: zod.ZodEnum<{
            decider: "decider";
            "owner-now": "owner-now";
            "owner-queue": "owner-queue";
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
        answered: "answered";
        decided: "decided";
        expired: "expired";
        "gone-elsewhere": "gone-elsewhere";
        open: "open";
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
    repeats: zod.ZodOptional<zod.ZodNumber>;
    lint: zod.ZodOptional<zod.ZodArray<zod.ZodString>>;
}, zod_v4_core.$strip>;

/** Items filed before `audience` existed carry none and stay owner items. */
declare function audienceOf(item: Pick<OwnerItem, "audience">): Audience;
/** Keeps the items for `audience`, in input order. */
declare function forAudience<T extends Pick<OwnerItem, "audience">>(items: readonly T[], audience: Audience): T[];

declare const HOLD_CLASSES: readonly ["g10", "owner-asked"];
/**
 * A merge-at-head that waits out a g10 hold: the owner approves now, and the merge goes through only once the adversary
 * loop closes with MERGE at the same head. Absent, the merge goes past the hold.
 */
declare const MERGE_WAITS: readonly ["adversary-loop"];
/**
 * The owner-only host commands a deposit may ask the owner to run, by id. A deposit names an id and never a path or argument:
 * the host that runs it maps each id to its own vetted command (TP-5265).
 */
declare const HOST_COMMANDS: readonly ["broker-restart-window"];
type HostCommand = (typeof HOST_COMMANDS)[number];
/**
 * The typed target of an owner action. It names what to act on and is never authority: the
 * system of record re-reads every field at tap time, so a deposit that lies only gets `moved`.
 */
declare const ownerOpSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
    waitFor: z.ZodOptional<z.ZodEnum<{
        "adversary-loop": "adversary-loop";
    }>>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"close-pr">;
    repo: z.ZodString;
    pr: z.ZodNumber;
    headSha: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"delete-branch">;
    repo: z.ZodString;
    branch: z.ZodString;
    tipSha: z.ZodString;
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
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"plan-bet-select">;
    initiative: z.ZodString;
    week: z.ZodString;
    bets: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"plan-outcome-edit">;
    outcome: z.ZodString;
    to: z.ZodObject<{
        statement: z.ZodOptional<z.ZodString>;
        measure: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    from: z.ZodOptional<z.ZodObject<{
        statement: z.ZodString;
        measure: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"plan-freeze-set">;
    initiative: z.ZodString;
    freeze: z.ZodDiscriminatedUnion<[z.ZodObject<{
        intent_ref: z.ZodString;
        quote_ref: z.ZodString;
        action: z.ZodLiteral<"set">;
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
                decrease: "decrease";
                increase: "increase";
            }>;
            threshold: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"owner">;
        }, z.core.$strict>], "kind">;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodLiteral<"end">;
        id: z.ZodString;
    }, z.core.$strict>], "action">;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"start-session">;
    name: z.ZodString;
    profile: z.ZodString;
    host: z.ZodString;
    account: z.ZodUnion<readonly [z.ZodLiteral<"least-used">, z.ZodString]>;
    cwd: z.ZodString;
    surface: z.ZodString;
    remoteControl: z.ZodBoolean;
    briefPath: z.ZodString;
    briefSha256: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"host-command">;
    command: z.ZodEnum<{
        "broker-restart-window": "broker-restart-window";
    }>;
}, z.core.$strict>], "kind">;
type OwnerOp = z.infer<typeof ownerOpSchema>;
type OwnerOpKind = OwnerOp["kind"];
/**
 * The merge keys an op implies, so an op about a PR joins that PR's hitl item at the same head, and two
 * deposits starting one session are one item. A gate op yields no `gate:` key: a deposit never claims to be the gate itself.
 */
declare function opKeys(op: OwnerOp): string[];

declare const BY_REC_POLICY_SCHEMA = "titan/auto-by-rec-policy@1";
declare const BY_REC_ROW_SCHEMA = "titan/auto-by-rec@1";
declare const BY_REC_MODES: readonly ["off", "shadow", "live"];
declare const BY_REC_SOURCES: readonly ["gate", "round", "deposit"];
declare const BY_REC_RESULTS: readonly ["would-resolve", "resolved", "skipped", "failed"];
/** The fields a policy exclusion can name; `hold`, `path` and `authority` match by prefix, the rest exactly. */
declare const BY_REC_EXCLUDE_FIELDS: readonly ["source", "id", "class", "hold", "category", "by", "path", "authority"];
/** Who an auto-by-rec resolution is attributed to: never the owner, never a coordinator delegate. */
declare const BY_REC_RESOLVER: Readonly<{
    readonly class: "automation";
    readonly id: "auto-by-rec";
}>;
declare const exclusionSchema: z.ZodObject<{
    field: z.ZodEnum<{
        authority: "authority";
        by: "by";
        category: "category";
        class: "class";
        hold: "hold";
        id: "id";
        path: "path";
        source: "source";
    }>;
    value: z.ZodString;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/**
 * The owner's policy file. It can turn the sweeps off, lengthen or shorten the wait, set a confidence floor and add
 * exclusions. Strict, so a file that tries to allow or unlist a floor class fails to parse rather than being ignored.
 */
declare const byRecPolicySchema: z.ZodObject<{
    schema: z.ZodLiteral<"titan/auto-by-rec-policy@1">;
    mode: z.ZodDefault<z.ZodEnum<{
        live: "live";
        off: "off";
        shadow: "shadow";
    }>>;
    afterHours: z.ZodDefault<z.ZodNumber>;
    minConfidence: z.ZodOptional<z.ZodNumber>;
    exclude: z.ZodDefault<z.ZodArray<z.ZodObject<{
        field: z.ZodEnum<{
            authority: "authority";
            by: "by";
            category: "category";
            class: "class";
            hold: "hold";
            id: "id";
            path: "path";
            source: "source";
        }>;
        value: z.ZodString;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
/** One auto-by-rec decision, written once per subject and mode: the facts read, what was done and why. */
declare const byRecRowSchema: z.ZodObject<{
    schema: z.ZodLiteral<"titan/auto-by-rec@1">;
    subject: z.ZodObject<{
        source: z.ZodEnum<{
            deposit: "deposit";
            gate: "gate";
            round: "round";
        }>;
        id: z.ZodString;
        summary: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    recommendation: z.ZodObject<{
        answer: z.ZodString;
        by: z.ZodString;
        rationale: z.ZodOptional<z.ZodString>;
        confidence: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    openedAt: z.ZodISODateTime;
    resolvedAt: z.ZodISODateTime;
    facts: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    mode: z.ZodEnum<{
        live: "live";
        shadow: "shadow";
    }>;
    result: z.ZodEnum<{
        failed: "failed";
        resolved: "resolved";
        skipped: "skipped";
        "would-resolve": "would-resolve";
    }>;
    reason: z.ZodOptional<z.ZodString>;
    resolver: z.ZodObject<{
        class: z.ZodLiteral<"automation">;
        id: z.ZodLiteral<"auto-by-rec">;
    }, z.core.$strict>;
}, z.core.$strict>;
type ByRecPolicy = z.infer<typeof byRecPolicySchema>;
type ByRecPolicyInput = z.input<typeof byRecPolicySchema>;
type ByRecExclusion = z.infer<typeof exclusionSchema>;
type ByRecRow = z.infer<typeof byRecRowSchema>;
type ByRecSource = (typeof BY_REC_SOURCES)[number];

interface ByRecRecommendation {
    answer: string;
    by: string;
    rationale?: string;
    confidence?: number;
}
/**
 * A gate, round question or deposit, normalized so one policy decides all three. The sweep that builds it reads every
 * fact fresh; any field it cannot read it leaves out, and only fields that refuse on presence are optional.
 */
interface ByRecSubject {
    source: ByRecSource;
    id: string;
    openedAt: string;
    summary?: string;
    recommendation?: ByRecRecommendation;
    /** OwnerItem kind, or `sitting` for a sitting deposit. */
    kind?: string;
    door?: "one-way" | "two-way";
    irreversible?: boolean;
    onSilence?: OnSilence;
    default?: string;
    options?: readonly string[];
    holdClasses?: readonly string[];
    /** The decision-routing D-row. */
    decisionClass?: string;
    authorityRows?: readonly string[];
    /** The table the authority rows come from; any table but `authority` refuses. */
    authorityTable?: string;
    ownerAtHead?: readonly string[];
    paths?: readonly string[];
    /** Set by a sweep whose own guard-path table matched a changed path. */
    guardPath?: boolean;
    headRef?: string;
    category?: string;
    op?: string;
    audience?: Audience;
    personal?: boolean;
    changeRequested?: boolean;
    /** A round with `recommendations: after-answer`, or a hidden pick. */
    blind?: boolean;
    ship?: boolean;
    planApproval?: boolean;
    /** Already answered, decided, expired, withdrawn or gone elsewhere. */
    closed?: boolean;
    /** Prompt, context and option text, scanned for a dollar amount. */
    text?: readonly string[];
}
type FloorRule = readonly [reason: string, refuses: (subject: ByRecSubject) => boolean];
/**
 * Authority and guard files: the authority package, g10 rules, hold and policy files, CI workflows, merge-lint,
 * CODEOWNERS, settings, and this policy itself.
 */
declare function isGuardPath(path: string): boolean;
/**
 * The exclusion floor, in code: a policy file can add exclusions but never remove one of these. Every rule refuses on
 * presence. The g10 rule matches by prefix, so a new g10 class fails closed, and the authority-row rule refuses every
 * family not on the auto-resolvable list, so a new table family fails closed.
 */
declare const BY_REC_FLOOR: readonly FloorRule[];
/** The first floor class the subject falls in, or undefined when none does. */
declare function floorReason(subject: ByRecSubject): string | undefined;

type ByRecDecision = {
    eligible: true;
    at: string;
    answer: string;
    rationale: string;
} | {
    eligible: false;
    reason: string;
    at?: string;
};
/**
 * Whether a subject resolves to its recommendation now. Pure: the sweep re-reads every fact, calls this, and acts or
 * logs. Shadow mode decides the same way as live; only the sweep's action differs. A skip that is only waiting on the
 * clock carries `at`, so a countdown can show when it becomes eligible.
 */
declare function byRecDecision(subject: ByRecSubject, now: Date, policy: ByRecPolicy): ByRecDecision;
/**
 * An owner-queue item (a deposit, or a round question read back) as a by-rec subject. The floor refuses only on facts
 * that are present, so every item field a floor rule keys on is mapped here. Hold classes, owner-at-head rows, the head
 * ref and plan approval are not item fields; a sweep that knows them sets them itself.
 */
declare function byRecSubjectOfItem(item: OwnerItem): ByRecSubject;

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
 * carrying an `answer`; others are ignored. An answer the item's own asker wrote (`ASKER_ANSWER_CLASS`, a sitting's
 * closing tally) is no one's decision, so it neither drops nor flags anything. Output is sorted, so input order never
 * changes it.
 */
declare function recheck(open: readonly OwnerItem[], answered: readonly OwnerItem[]): Recheck;

interface WithdrawnItem {
    /** The item relabelled `withdrawn`; an answer it carried is kept, so a change request stays readable. */
    item: OwnerItem;
    /** The status it had before it was withdrawn. */
    was: ItemStatus;
    /** `<owner>/<repo>#<n>`, lower-cased. */
    pr: string;
    /** `new-head:<live sha>`, or a seat's withdraw reason. */
    reason: string;
    /** Who withdrew a seat's deposit, when the withdrawal recorded one; a supersede has none. */
    actor?: string;
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
/**
 * The key an alarm deposit carries for the thing that raised it, such as `alarm:console-update`. Open
 * deposits from one asker with the same alarm key are one alarm repeating (`collapseRepeats`).
 */
declare function alarmKey(source: string): string;
/** A PR key pinned to its head, in the canonical form `mergeByKeys` compares. */
declare function prKey(repo: string, pr: number, headSha: string): string;
/** The key a start-session op carries, so two deposits asking to start the same session are one item. */
declare function sessionKey(name: string): string;
interface ParsedPrKey {
    /** Lower-cased `owner/repo#number`, or whatever text follows `pr:` when it is not that shape. */
    pr: string;
    /** The full 40-hex head the key pins, lower-cased; null for no head, a short sha or a malformed ref. */
    sha: string | null;
    /** The text after `@`, lower-cased, or null when the key names no head. Unlike `sha`, it keeps a head that cannot be read, so a caller that must not settle on an unknown head can tell it from no head. */
    head: string | null;
}
/**
 * The one reading of a `pr:` key: trimmed and lower-cased, since GitHub names and shas compare
 * case-insensitively. Only a well-formed ref at a full head sha pins; a short sha pins nothing.
 * Null for any key that is not a `pr:` key.
 */
declare function parsePrKey(key: string): ParsedPrKey | null;
/** The relation kind of a key, or null for a merge key or anything else. */
declare function relationKind(key: string): RelationKeyKind | null;

/**
 * Collapses open items one asker filed with the same `alarm:` key into the newest of them, which
 * carries `repeats` when it stands for more than itself. Items with no alarm key pass through;
 * the kept item holds its own place in the order.
 */
declare function collapseRepeats(items: readonly OwnerItem[]): OwnerItem[];

/** A key merges only in its exact, complete form: a PR ref needs its full 40-hex head sha. */
declare function isMergeKey(key: string): boolean;
/**
 * Merges items from every source that share an exact key, including the head sha of a PR key.
 * Items naming two different heads of one PR stay apart even when another key matches: one
 * answer must never approve a head nobody reviewed. Output keeps the order of each group's first item.
 */
declare function mergeByKeys(items: readonly OwnerItem[]): OwnerItem[];

/** Every break a renderer or reader may start a new line at, not only `\n`: split on this to keep a caller's own lines. */
declare const PROMPT_LINE_BREAK: RegExp;
interface PromptLineOptions {
    /** What a line break becomes; a space unless the caller marks breaks visibly. */
    lineBreak?: string;
}
/** One line safe to show: escape sequences and invisible characters go, a tab becomes a space, a break becomes `lineBreak`. */
declare function promptLine(text: string, { lineBreak }?: PromptLineOptions): string;

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

type PlanGate = "ci-policy" | "skill" | "visual" | "task";
/** A ci-policy approval pins each file the PR changes by its git blob sha; null means the file is absent at head. */
interface CiPolicyPlanScope {
    ciPolicyKeys: string[];
    files: {
        path: string;
        blob: string | null;
    }[];
}
/** A skill or visual approval pins exact paths, not content. */
interface PathPlanScope {
    paths: string[];
}
/** A task approval validates the task's WHAT: the done_when text the owner read in the scope card, and the owner-rule reason it needed them. */
interface TaskPlanScope {
    doneWhen: string;
    reason: "new-direction" | "one-way-door" | "new-cap" | "authority-widening";
    visualSignoff: boolean;
}
type PlanGateScope = {
    gate: "ci-policy";
    scope: CiPolicyPlanScope;
} | {
    gate: "skill" | "visual";
    scope: PathPlanScope;
} | {
    gate: "task";
    scope: TaskPlanScope;
};
/** `title` heads the question's section and `context` is what the owner reads beside the pinned scope. */
type PlanAsk = PlanGateScope & {
    title: string;
    context: string;
};
/** One `planApprovals` entry: the owner's pick of `approve` on `questionId` records this task, repo, gate and scope. */
type PlanApproval = {
    questionId: string;
    approve: string;
    task: string;
    repo: string;
} & PlanGateScope;
interface PlanRoundInput {
    unit: string;
    round: number;
    /** A loopback Storybook URL; round@2 requires one even for a questions-only round. Default http://127.0.0.1:6006/. */
    storybookUrl?: string;
    /** Ids of earlier rounds this one replaces. */
    supersedes?: string[];
    task: string;
    repo: string;
    asks: readonly PlanAsk[];
}
/** The round.json the console files: a round@2 manifest plus the console's own `supersedes` and `planApprovals` fields. */
type PlanRound = ManifestInput & {
    supersedes?: string[];
    planApprovals: PlanApproval[];
};
/**
 * Turns one PR's predicted WHAT gates into a questions-only round@2 round.json whose `planApprovals` bind each question's
 * approve option to the plan-approval entry the console records (TP-4357). The planner does not recommend its own approval,
 * so no question carries a recommendation. Pure: no I/O and no clock.
 *
 * Throws when `asks` is empty or `storybookUrl` is not loopback, and parses the manifest with RoundSchema before returning.
 */
declare function buildPlanRound(input: PlanRoundInput): PlanRound;

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

export { type AnsweredContext, Audience, BY_REC_EXCLUDE_FIELDS, BY_REC_FLOOR, BY_REC_MODES, BY_REC_POLICY_SCHEMA, BY_REC_RESOLVER, BY_REC_RESULTS, BY_REC_ROW_SCHEMA, BY_REC_SOURCES, type ByRecDecision, type ByRecExclusion, type ByRecPolicy, type ByRecPolicyInput, type ByRecRecommendation, type ByRecRow, type ByRecSource, type ByRecSubject, CARD_RULES, type CardRule, type CiPolicyPlanScope, type ClosedStatus, type ConsolidateInput, type FeedbackInput, type Flow, type FlowGroup, HOLD_CLASSES, type HeldItem, type HostCommand, INFLUENCE_RULES, type InfluenceContext, type InfluenceEdge, type InfluenceRule, ItemStatus, MERGE_WAITS, OnSilence, OwnerAnswer, OwnerItem, type OwnerOp, type OwnerOpKind, type OwnerRound, type OwnerRoundOptions, type OwnerRounds, PARKED, PROMPT_LINE_BREAK, type PathPlanScope, type PlanApproval, type PlanAsk, type PlanGate, type PlanGateScope, type PlanRound, type PlanRoundInput, type Principle, type PromptLineOptions, type QueueSource, RELATION_KEY_KINDS, ROUND_ANSWERER, type Recheck, type RecheckCite, type RecheckDrop, type RecheckFlag, type RecheckFlagKind, type RelationKeyKind, type ResolveResult, type RoundItemsContext, type RoundQuestionBinding, STALE_RULES, type ShipBlock, type ShipBlockReason, type SkipReason, type SourceEvent, SourceRef, type StackedItem, type StaleEvidence, type StaleLabel, type StaleRule, type Superseded, type TaskPlanScope, type WithdrawnItem, alarmKey, answeredFromFeedback, askKey, audienceOf, buildOwnerRounds, buildPlanRound, byRecDecision, byRecPolicySchema, byRecRowSchema, byRecSubjectOfItem, cardLint, collapseRepeats, componentKey, consolidate, floorReason, forAudience, fromRoundQuestions, influenceEdges, isGuardPath, isMergeKey, mergeByKeys, opKeys, ownerCardSchema, ownerOpSchema, parsePrKey, prKey, promptLine, rank, recheck, relationKind, roundAskKey, roundItemId, sessionKey, stackContext, staleLabel, supersede, tokenKey, topicKey };

// ./dist/deposit.d.ts
import { z } from 'zod';
import { O as OwnerItem } from './schema.js';

/**
 * What an agent may file into the owner inbox. Strict at every level, so a deposit that tries
 * to set a system field (id, status, answer, route, authority, lint, a hidden pick) is refused
 * rather than silently stripped.
 */
declare const ownerItemDepositSchema: z.ZodObject<{
    depositId: z.ZodString;
    asker: z.ZodString;
    kind: z.ZodEnum<{
        approve: "approve";
        decide: "decide";
        do: "do";
        know: "know";
        review: "review";
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
        waitFor: z.ZodOptional<z.ZodEnum<{
            "adversary-loop": "adversary-loop";
        }>>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"close-pr">;
        repo: z.ZodString;
        pr: z.ZodNumber;
        headSha: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"delete-branch">;
        repo: z.ZodString;
        branch: z.ZodString;
        tipSha: z.ZodString;
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
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"plan-bet-select">;
        initiative: z.ZodString;
        week: z.ZodString;
        bets: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"plan-outcome-edit">;
        outcome: z.ZodString;
        to: z.ZodObject<{
            statement: z.ZodOptional<z.ZodString>;
            measure: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        from: z.ZodOptional<z.ZodObject<{
            statement: z.ZodString;
            measure: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"plan-freeze-set">;
        initiative: z.ZodString;
        freeze: z.ZodDiscriminatedUnion<[z.ZodObject<{
            intent_ref: z.ZodString;
            quote_ref: z.ZodString;
            action: z.ZodLiteral<"set">;
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
                    decrease: "decrease";
                    increase: "increase";
                }>;
                threshold: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"owner">;
            }, z.core.$strict>], "kind">;
        }, z.core.$strict>, z.ZodObject<{
            action: z.ZodLiteral<"end">;
            id: z.ZodString;
        }, z.core.$strict>], "action">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"start-session">;
        name: z.ZodString;
        profile: z.ZodString;
        host: z.ZodString;
        account: z.ZodUnion<readonly [z.ZodLiteral<"least-used">, z.ZodString]>;
        cwd: z.ZodString;
        surface: z.ZodString;
        remoteControl: z.ZodBoolean;
        briefPath: z.ZodString;
        briefSha256: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"host-command">;
        command: z.ZodEnum<{
            "broker-restart-window": "broker-restart-window";
        }>;
    }, z.core.$strict>], "kind">>;
    steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        command: z.ZodString;
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
            waitFor: z.ZodOptional<z.ZodEnum<{
                "adversary-loop": "adversary-loop";
            }>>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"close-pr">;
            repo: z.ZodString;
            pr: z.ZodNumber;
            headSha: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"delete-branch">;
            repo: z.ZodString;
            branch: z.ZodString;
            tipSha: z.ZodString;
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
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"plan-bet-select">;
            initiative: z.ZodString;
            week: z.ZodString;
            bets: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"plan-outcome-edit">;
            outcome: z.ZodString;
            to: z.ZodObject<{
                statement: z.ZodOptional<z.ZodString>;
                measure: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
            from: z.ZodOptional<z.ZodObject<{
                statement: z.ZodString;
                measure: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"plan-freeze-set">;
            initiative: z.ZodString;
            freeze: z.ZodDiscriminatedUnion<[z.ZodObject<{
                intent_ref: z.ZodString;
                quote_ref: z.ZodString;
                action: z.ZodLiteral<"set">;
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
                        decrease: "decrease";
                        increase: "increase";
                    }>;
                    threshold: z.ZodNumber;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"owner">;
                }, z.core.$strict>], "kind">;
            }, z.core.$strict>, z.ZodObject<{
                action: z.ZodLiteral<"end">;
                id: z.ZodString;
            }, z.core.$strict>], "action">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"start-session">;
            name: z.ZodString;
            profile: z.ZodString;
            host: z.ZodString;
            account: z.ZodUnion<readonly [z.ZodLiteral<"least-used">, z.ZodString]>;
            cwd: z.ZodString;
            surface: z.ZodString;
            remoteControl: z.ZodBoolean;
            briefPath: z.ZodString;
            briefSha256: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"host-command">;
            command: z.ZodEnum<{
                "broker-restart-window": "broker-restart-window";
            }>;
        }, z.core.$strict>], "kind">>;
        verify: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
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
    unblocksNow: z.ZodOptional<z.ZodString>;
    blocker: z.ZodOptional<z.ZodObject<{
        since: z.ZodISODateTime;
        blocks: z.ZodString;
    }, z.core.$strict>>;
    audience: z.ZodOptional<z.ZodEnum<{
        operator: "operator";
        owner: "owner";
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
/**
 * Parses an untrusted deposit and returns the open OwnerItem it files; throws on a refused deposit.
 * An `op` adds the keys it implies, so a deposit about a PR joins that PR's item at the same head.
 */
declare function fromDeposit(deposit: OwnerItemDeposit, now: Date): OwnerItem;

export { DEPOSIT_LENS as D, type OwnerItemDeposit as O, depositItemId as d, fromDeposit as f, ownerItemDepositSchema as o };

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
        "active-work": "active-work";
        "agent-chat": "agent-chat";
        deposit: "deposit";
        hitl: "hitl";
        morning: "morning";
        plan: "plan";
        round: "round";
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
declare const STEP_OUTCOMES: readonly ["done", "skipped"];
/** A step as the inbox reads it: the deposit's step plus the outcome its asker recorded, if any. */
declare const itemStepSchema: z.ZodObject<{
    title: z.ZodString;
    command: z.ZodString;
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
        waitFor: z.ZodOptional<z.ZodEnum<{
            "adversary-loop": "adversary-loop";
        }>>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"close-pr">;
        repo: z.ZodString;
        pr: z.ZodNumber;
        headSha: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"delete-branch">;
        repo: z.ZodString;
        branch: z.ZodString;
        tipSha: z.ZodString;
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
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"plan-bet-select">;
        initiative: z.ZodString;
        week: z.ZodString;
        bets: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"plan-outcome-edit">;
        outcome: z.ZodString;
        to: z.ZodObject<{
            statement: z.ZodOptional<z.ZodString>;
            measure: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        from: z.ZodOptional<z.ZodObject<{
            statement: z.ZodString;
            measure: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"plan-freeze-set">;
        initiative: z.ZodString;
        freeze: z.ZodDiscriminatedUnion<[z.ZodObject<{
            intent_ref: z.ZodString;
            quote_ref: z.ZodString;
            action: z.ZodLiteral<"set">;
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
                    decrease: "decrease";
                    increase: "increase";
                }>;
                threshold: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"owner">;
            }, z.core.$strict>], "kind">;
        }, z.core.$strict>, z.ZodObject<{
            action: z.ZodLiteral<"end">;
            id: z.ZodString;
        }, z.core.$strict>], "action">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"start-session">;
        name: z.ZodString;
        profile: z.ZodString;
        host: z.ZodString;
        account: z.ZodUnion<readonly [z.ZodLiteral<"least-used">, z.ZodString]>;
        cwd: z.ZodString;
        surface: z.ZodString;
        remoteControl: z.ZodBoolean;
        briefPath: z.ZodString;
        briefSha256: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"host-command">;
        command: z.ZodEnum<{
            "broker-restart-window": "broker-restart-window";
        }>;
    }, z.core.$strict>], "kind">>;
    verify: z.ZodOptional<z.ZodString>;
    outcome: z.ZodOptional<z.ZodEnum<{
        done: "done";
        skipped: "skipped";
    }>>;
}, z.core.$strict>;
declare const ownerItemSchema: z.ZodObject<{
    id: z.ZodString;
    sources: z.ZodArray<z.ZodObject<{
        system: z.ZodEnum<{
            "active-work": "active-work";
            "agent-chat": "agent-chat";
            deposit: "deposit";
            hitl: "hitl";
            morning: "morning";
            plan: "plan";
            round: "round";
        }>;
        ref: z.ZodString;
    }, z.core.$strip>>;
    kind: z.ZodEnum<{
        approve: "approve";
        decide: "decide";
        do: "do";
        know: "know";
        review: "review";
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
        waitFor: z.ZodOptional<z.ZodEnum<{
            "adversary-loop": "adversary-loop";
        }>>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"close-pr">;
        repo: z.ZodString;
        pr: z.ZodNumber;
        headSha: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"delete-branch">;
        repo: z.ZodString;
        branch: z.ZodString;
        tipSha: z.ZodString;
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
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"plan-bet-select">;
        initiative: z.ZodString;
        week: z.ZodString;
        bets: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"plan-outcome-edit">;
        outcome: z.ZodString;
        to: z.ZodObject<{
            statement: z.ZodOptional<z.ZodString>;
            measure: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        from: z.ZodOptional<z.ZodObject<{
            statement: z.ZodString;
            measure: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"plan-freeze-set">;
        initiative: z.ZodString;
        freeze: z.ZodDiscriminatedUnion<[z.ZodObject<{
            intent_ref: z.ZodString;
            quote_ref: z.ZodString;
            action: z.ZodLiteral<"set">;
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
                    decrease: "decrease";
                    increase: "increase";
                }>;
                threshold: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"owner">;
            }, z.core.$strict>], "kind">;
        }, z.core.$strict>, z.ZodObject<{
            action: z.ZodLiteral<"end">;
            id: z.ZodString;
        }, z.core.$strict>], "action">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"start-session">;
        name: z.ZodString;
        profile: z.ZodString;
        host: z.ZodString;
        account: z.ZodUnion<readonly [z.ZodLiteral<"least-used">, z.ZodString]>;
        cwd: z.ZodString;
        surface: z.ZodString;
        remoteControl: z.ZodBoolean;
        briefPath: z.ZodString;
        briefSha256: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"host-command">;
        command: z.ZodEnum<{
            "broker-restart-window": "broker-restart-window";
        }>;
    }, z.core.$strict>], "kind">>;
    steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        command: z.ZodString;
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
            waitFor: z.ZodOptional<z.ZodEnum<{
                "adversary-loop": "adversary-loop";
            }>>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"close-pr">;
            repo: z.ZodString;
            pr: z.ZodNumber;
            headSha: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"delete-branch">;
            repo: z.ZodString;
            branch: z.ZodString;
            tipSha: z.ZodString;
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
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"plan-bet-select">;
            initiative: z.ZodString;
            week: z.ZodString;
            bets: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"plan-outcome-edit">;
            outcome: z.ZodString;
            to: z.ZodObject<{
                statement: z.ZodOptional<z.ZodString>;
                measure: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
            from: z.ZodOptional<z.ZodObject<{
                statement: z.ZodString;
                measure: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"plan-freeze-set">;
            initiative: z.ZodString;
            freeze: z.ZodDiscriminatedUnion<[z.ZodObject<{
                intent_ref: z.ZodString;
                quote_ref: z.ZodString;
                action: z.ZodLiteral<"set">;
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
                        decrease: "decrease";
                        increase: "increase";
                    }>;
                    threshold: z.ZodNumber;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"owner">;
                }, z.core.$strict>], "kind">;
            }, z.core.$strict>, z.ZodObject<{
                action: z.ZodLiteral<"end">;
                id: z.ZodString;
            }, z.core.$strict>], "action">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"start-session">;
            name: z.ZodString;
            profile: z.ZodString;
            host: z.ZodString;
            account: z.ZodUnion<readonly [z.ZodLiteral<"least-used">, z.ZodString]>;
            cwd: z.ZodString;
            surface: z.ZodString;
            remoteControl: z.ZodBoolean;
            briefPath: z.ZodString;
            briefSha256: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"host-command">;
            command: z.ZodEnum<{
                "broker-restart-window": "broker-restart-window";
            }>;
        }, z.core.$strict>], "kind">>;
        verify: z.ZodOptional<z.ZodString>;
        outcome: z.ZodOptional<z.ZodEnum<{
            done: "done";
            skipped: "skipped";
        }>>;
    }, z.core.$strict>>>;
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
        fyi: "fyi";
        planning: "planning";
        stuck: "stuck";
    }>;
    stuckKind: z.ZodOptional<z.ZodString>;
    unblocks: z.ZodArray<z.ZodString>;
    unblocksNow: z.ZodOptional<z.ZodString>;
    blocker: z.ZodOptional<z.ZodObject<{
        since: z.ZodISODateTime;
        blocks: z.ZodString;
    }, z.core.$strict>>;
    audience: z.ZodOptional<z.ZodEnum<{
        operator: "operator";
        owner: "owner";
    }>>;
    route: z.ZodOptional<z.ZodObject<{
        target: z.ZodEnum<{
            decider: "decider";
            "owner-now": "owner-now";
            "owner-queue": "owner-queue";
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
        answered: "answered";
        decided: "decided";
        expired: "expired";
        "gone-elsewhere": "gone-elsewhere";
        open: "open";
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
type SittingStep = z.infer<typeof itemStepSchema>;
type StepOutcome = (typeof STEP_OUTCOMES)[number];

export { type Audience as A, DOORS as D, type ItemStatus as I, LENSES as L, type OwnerItem as O, ROUTE_TARGETS as R, type SourceRef as S, type OnSilence as a, type OwnerAnswer as b, AUDIENCES as c, ITEM_KINDS as d, ITEM_STATUSES as e, type LocatorCite as f, ON_SILENCE_ACTIONS as g, SOURCE_SYSTEMS as h, type SittingStep as i, type StepOutcome as j, locatorCiteSchema as l, ownerItemSchema as o, sourceRefSchema as s };
