import { j as StepOutcome, O as OwnerItem } from './schema.js';
import 'zod';

declare const SITTING_LOG = "sittings.jsonl";
/** The answer's `by.channel` on a sitting closed by its last step, so no reader mistakes it for an owner's pick. */
declare const SITTING_CLOSE_CHANNEL = "inbox-step";
/** `unknown`: no deposit matches this id. `refused`: not a sitting, not this asker's, no such step, or already closed. */
declare class StepRefusedError extends Error {
    readonly kind: "unknown" | "refused";
    constructor(message: string, kind: "unknown" | "refused");
}
interface StepRequest {
    outcome: StepOutcome;
    /** Must equal the sitting's asker. */
    as: string;
    /** Who runs the verb; recorded beside the asker. */
    actor: string;
    now?: Date;
}
interface StepResult {
    id: string;
    step: number;
    /** The step's outcome as filed: on `already-recorded`, the first one, which may differ from the request. */
    outcome: StepOutcome;
    result: "recorded" | "already-recorded";
    /** True once every step is done or skipped, so the sitting is answered and closed. */
    closed: boolean;
}
/** The item with each step's recorded outcome; an item with no steps comes back as it was. Throws on a malformed marker. */
declare function withStepOutcomes(dir: string, item: OwnerItem): Promise<OwnerItem>;
/**
 * Records step `step` (1-based) of the sitting `ref` names, which `as` filed, as done or skipped. Throws StepRefusedError
 * on an unknown id or a refusal. The last outcome closes the sitting.
 */
declare function recordStep(dir: string, ref: string, step: number, { outcome, as, actor, now }: StepRequest): Promise<StepResult>;

export { SITTING_CLOSE_CHANNEL, SITTING_LOG, StepRefusedError, type StepRequest, type StepResult, recordStep, withStepOutcomes };

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
