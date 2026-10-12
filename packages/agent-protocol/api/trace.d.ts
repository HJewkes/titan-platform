import { z } from 'zod';
import { ConversationIdentity, UsageMeasurement } from '../index.js';

declare const TRACE_SCHEMA_VERSION = "titan.trace/v1";
declare const TRACE_RECORD_KINDS: readonly ["run", "attempt", "call", "gate", "artifact", "cost"];
declare const TRACE_ARTIFACT_KINDS: readonly ["commit", "pr", "file"];
/** Mirrors workflow's WorkflowStatus; agent-protocol sits below workflow, so the S2 contract test pins the match. */
declare const TRACE_RUN_STATUSES: readonly ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];
declare const TRACE_STEP_KINDS: readonly ["dispatch", "seed", "assisted", "authorize"];
/** Mirrors hitl's GateStatus for the same tier reason. */
declare const TRACE_GATE_STATUSES: readonly ["pending", "resolved", "cancelled", "expired"];
declare const TRACE_GATE_VERDICTS: readonly ["allow", "deny", "revise"];
declare const TRACE_CHECK_STATES: readonly ["passing", "failing", "pending"];
type TraceParseMode = "strict" | "loose";

declare const SHA256_PATTERN: RegExp;
declare const REPO_PATTERN: RegExp;
declare const COMMIT_SHA_PATTERN: RegExp;
/** The shape `workflowStepRequestKey` emits: four URI-encoded components, the last two integers. */
declare const ATTEMPT_ID_PATTERN: RegExp;
/** `gateIdFor` and `assistedKey`: `<runId>/<stepId>` with an optional `:<iteration>`. */
declare const HUMAN_GATE_ID_PATTERN: RegExp;
declare const POLICY_GATE_ID_PATTERN: RegExp;
declare const COMMIT_ID_PATTERN: RegExp;
declare const PR_ID_PATTERN: RegExp;
/** `fileRef` plus an `@<sha>` suffix, so two versions of one file get different ids. */
declare const FILE_ID_PATTERN: RegExp;
declare const CALL_ID_PATTERN: RegExp;
declare const COST_ID_PATTERN: RegExp;
declare const CONVERSATION_REF_PATTERN: RegExp;
declare const TURN_REF_PATTERN: RegExp;
declare function commitRef(repo: string, sha: string): string;
declare function policyGateId(attemptId: string, table: string, rowId: string): string;
/** Deltas key on the response id; snapshots on their scope and epoch, so the latest sequence upserts over earlier ones. */
declare function costId(conversation: ConversationIdentity, measurement: UsageMeasurement): string;

/**
 * export: kept. digest: replaced by `hmac-sha256:<hex>` keyed by the export's key, so equal values join
 * within one export and a guess can't be confirmed without the key.
 * public: kept only when the record's repo is public, else digested. local: dropped.
 * mcp-local: local when the tool call belongs to an MCP server, else export. actor: digest for `agent:` actors, else export.
 */
type TracePrivacyClass = "export" | "digest" | "public" | "local" | "mcp-local" | "actor";
type TracePrivacyScope = "run" | "attempt" | "call" | "gate" | "artifact.commit" | "artifact.pr" | "artifact.file" | "cost";
type ClassMap = Readonly<Record<string, TracePrivacyClass>>;
/** Every leaf path of every record kind; `*` stands for any record key, `[]` for any array element. */
declare const TRACE_FIELD_PRIVACY: Readonly<Record<TracePrivacyScope, ClassMap>>;
/** Correlation keys survive redaction so a reader can see which joins existed; their values are replaced by this marker. */
declare const REDACTED_LOCAL_VALUE = "[local]";
interface RedactTraceOptions {
    /** `owner/name` repos whose ids, paths and shas may leave the machine. */
    publicRepos: readonly string[];
    /** Secret HMAC key for this export. Reuse it to join across exports; never ship it with the export. */
    key: string;
}
declare function tracePrivacyScope(record: TraceRecord): TracePrivacyScope;
/** Keys with no class, such as extras kept by a loose parse, are dropped. */
declare function redactTraceRecord(record: TraceRecord, options: RedactTraceOptions): Promise<Record<string, unknown>>;

declare const loose: {
    span: z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>;
    measurement: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"delta">;
        responseId: z.ZodString;
        model: z.ZodNullable<z.ZodString>;
        tokens: z.ZodObject<{
            input: z.ZodNullable<z.ZodNumber>;
            output: z.ZodNullable<z.ZodNumber>;
            cachedInput: z.ZodNullable<z.ZodNumber>;
            cacheWriteInput: z.ZodNullable<z.ZodNumber>;
            reasoningOutput: z.ZodNullable<z.ZodNumber>;
            total: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        cost: z.ZodNullable<z.ZodObject<{
            usd: z.ZodNumber;
            kind: z.ZodEnum<{
                estimate: "estimate";
                reported: "reported";
            }>;
        }, z.core.$strict>>;
        source: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"snapshot">;
        scope: z.ZodEnum<{
            turn: "turn";
            conversation: "conversation";
        }>;
        scopeId: z.ZodString;
        epoch: z.ZodString;
        sequence: z.ZodNumber;
        model: z.ZodNullable<z.ZodString>;
        tokens: z.ZodObject<{
            input: z.ZodNullable<z.ZodNumber>;
            output: z.ZodNullable<z.ZodNumber>;
            cachedInput: z.ZodNullable<z.ZodNumber>;
            cacheWriteInput: z.ZodNullable<z.ZodNumber>;
            reasoningOutput: z.ZodNullable<z.ZodNumber>;
            total: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        cost: z.ZodNullable<z.ZodObject<{
            usd: z.ZodNumber;
            kind: z.ZodEnum<{
                estimate: "estimate";
                reported: "reported";
            }>;
        }, z.core.$strict>>;
        source: z.ZodString;
    }, z.core.$strict>], "kind">;
    run: z.ZodObject<{
        workflowName: z.ZodString;
        status: z.ZodEnum<{
            running: "running";
            paused: "paused";
            cancelling: "cancelling";
            recovery_required: "recovery_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        completedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
        error: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        correlations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        paramsSha256: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"run">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        workflowName: z.ZodString;
        status: z.ZodEnum<{
            running: "running";
            paused: "paused";
            cancelling: "cancelling";
            recovery_required: "recovery_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        completedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
        error: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        correlations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        paramsSha256: z.ZodOptional<z.ZodString>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"run">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>;
    attempt: z.ZodObject<{
        stepId: z.ZodString;
        iteration: z.ZodNumber;
        attempt: z.ZodNumber;
        stepKind: z.ZodEnum<{
            dispatch: "dispatch";
            seed: "seed";
            assisted: "assisted";
            authorize: "authorize";
        }>;
        executionId: z.ZodOptional<z.ZodString>;
        phase: z.ZodOptional<z.ZodEnum<{
            running: "running";
            recovery_required: "recovery_required";
            failed: "failed";
            cancelled: "cancelled";
            prepared: "prepared";
            dispatching: "dispatching";
            cancel_requested: "cancel_requested";
            succeeded: "succeeded";
            cancellation_unknown: "cancellation_unknown";
            ended: "ended";
        }>>;
        outcome: z.ZodOptional<z.ZodEnum<{
            recovery_required: "recovery_required";
            failed: "failed";
            cancelled: "cancelled";
            succeeded: "succeeded";
            cancellation_unknown: "cancellation_unknown";
        }>>;
        retryable: z.ZodOptional<z.ZodBoolean>;
        error: z.ZodOptional<z.ZodString>;
        signal: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        runnerRef: z.ZodOptional<z.ZodString>;
        agentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        conversation: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        completedAt: z.ZodOptional<z.ZodISODateTime>;
        usage: z.ZodOptional<z.ZodObject<{
            costUsd: z.ZodNumber;
            inputTokens: z.ZodOptional<z.ZodNumber>;
            outputTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        recovery: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                unknown: "unknown";
                legacy_unrecoverable: "legacy_unrecoverable";
                not_found: "not_found";
                ownership_lost: "ownership_lost";
            }>;
            observedAt: z.ZodISODateTime;
        }, z.core.$strict>>;
        promptSha256: z.ZodOptional<z.ZodString>;
        outputSha256: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"attempt">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        stepId: z.ZodString;
        iteration: z.ZodNumber;
        attempt: z.ZodNumber;
        stepKind: z.ZodEnum<{
            dispatch: "dispatch";
            seed: "seed";
            assisted: "assisted";
            authorize: "authorize";
        }>;
        executionId: z.ZodOptional<z.ZodString>;
        phase: z.ZodOptional<z.ZodEnum<{
            running: "running";
            recovery_required: "recovery_required";
            failed: "failed";
            cancelled: "cancelled";
            prepared: "prepared";
            dispatching: "dispatching";
            cancel_requested: "cancel_requested";
            succeeded: "succeeded";
            cancellation_unknown: "cancellation_unknown";
            ended: "ended";
        }>>;
        outcome: z.ZodOptional<z.ZodEnum<{
            recovery_required: "recovery_required";
            failed: "failed";
            cancelled: "cancelled";
            succeeded: "succeeded";
            cancellation_unknown: "cancellation_unknown";
        }>>;
        retryable: z.ZodOptional<z.ZodBoolean>;
        error: z.ZodOptional<z.ZodString>;
        signal: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        runnerRef: z.ZodOptional<z.ZodString>;
        agentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        conversation: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        completedAt: z.ZodOptional<z.ZodISODateTime>;
        usage: z.ZodOptional<z.ZodObject<{
            costUsd: z.ZodNumber;
            inputTokens: z.ZodOptional<z.ZodNumber>;
            outputTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        recovery: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                unknown: "unknown";
                legacy_unrecoverable: "legacy_unrecoverable";
                not_found: "not_found";
                ownership_lost: "ownership_lost";
            }>;
            observedAt: z.ZodISODateTime;
        }, z.core.$strict>>;
        promptSha256: z.ZodOptional<z.ZodString>;
        outputSha256: z.ZodOptional<z.ZodString>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"attempt">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>;
    call: z.ZodObject<{
        callKind: z.ZodEnum<{
            model: "model";
            tool: "tool";
        }>;
        name: z.ZodString;
        namespace: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        conversation: z.ZodString;
        turn: z.ZodOptional<z.ZodString>;
        isError: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
        span: z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"call">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        callKind: z.ZodEnum<{
            model: "model";
            tool: "tool";
        }>;
        name: z.ZodString;
        namespace: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        conversation: z.ZodString;
        turn: z.ZodOptional<z.ZodString>;
        isError: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
        span: z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"call">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>;
    gate: z.ZodObject<{
        gateKind: z.ZodEnum<{
            human: "human";
            policy: "policy";
        }>;
        status: z.ZodOptional<z.ZodEnum<{
            cancelled: "cancelled";
            pending: "pending";
            resolved: "resolved";
            expired: "expired";
        }>>;
        verdict: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            allow: "allow";
            deny: "deny";
            revise: "revise";
        }>>>;
        decidedBy: z.ZodOptional<z.ZodString>;
        policyRule: z.ZodOptional<z.ZodObject<{
            table: z.ZodString;
            rowId: z.ZodString;
            version: z.ZodNumber;
        }, z.core.$strict>>;
        resolvedAt: z.ZodOptional<z.ZodISODateTime>;
        expiresAt: z.ZodOptional<z.ZodISODateTime>;
        reason: z.ZodOptional<z.ZodString>;
        promptSha256: z.ZodOptional<z.ZodString>;
        payloadSha256: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"gate">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        gateKind: z.ZodEnum<{
            human: "human";
            policy: "policy";
        }>;
        status: z.ZodOptional<z.ZodEnum<{
            cancelled: "cancelled";
            pending: "pending";
            resolved: "resolved";
            expired: "expired";
        }>>;
        verdict: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            allow: "allow";
            deny: "deny";
            revise: "revise";
        }>>>;
        decidedBy: z.ZodOptional<z.ZodString>;
        policyRule: z.ZodOptional<z.ZodObject<{
            table: z.ZodString;
            rowId: z.ZodString;
            version: z.ZodNumber;
        }, z.core.$strict>>;
        resolvedAt: z.ZodOptional<z.ZodISODateTime>;
        expiresAt: z.ZodOptional<z.ZodISODateTime>;
        reason: z.ZodOptional<z.ZodString>;
        promptSha256: z.ZodOptional<z.ZodString>;
        payloadSha256: z.ZodOptional<z.ZodString>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"gate">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>;
    artifact: z.ZodDiscriminatedUnion<[z.ZodObject<{
        artifactKind: z.ZodLiteral<"commit">;
        sha: z.ZodString;
        branch: z.ZodOptional<z.ZodString>;
        reverts: z.ZodOptional<z.ZodString>;
        repo: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"artifact">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        artifactKind: z.ZodLiteral<"commit">;
        sha: z.ZodString;
        branch: z.ZodOptional<z.ZodString>;
        reverts: z.ZodOptional<z.ZodString>;
        repo: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"artifact">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        artifactKind: z.ZodLiteral<"pr">;
        number: z.ZodNumber;
        state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        mergedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
        closedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
        reviewRounds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        checks: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            pending: "pending";
            passing: "passing";
            failing: "failing";
        }>>>;
        repo: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"artifact">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        artifactKind: z.ZodLiteral<"pr">;
        number: z.ZodNumber;
        state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        mergedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
        closedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
        reviewRounds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        checks: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            pending: "pending";
            passing: "passing";
            failing: "failing";
        }>>>;
        repo: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"artifact">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        artifactKind: z.ZodLiteral<"file">;
        path: z.ZodString;
        commit: z.ZodOptional<z.ZodString>;
        lines: z.ZodOptional<z.ZodArray<z.ZodObject<{
            lineStart: z.ZodNumber;
            lineEnd: z.ZodNumber;
        }, z.core.$strict>>>;
        repo: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"artifact">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        artifactKind: z.ZodLiteral<"file">;
        path: z.ZodString;
        commit: z.ZodOptional<z.ZodString>;
        lines: z.ZodOptional<z.ZodArray<z.ZodObject<{
            lineStart: z.ZodNumber;
            lineEnd: z.ZodNumber;
        }, z.core.$strict>>>;
        repo: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"artifact">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>], "artifactKind">;
    cost: z.ZodObject<{
        conversation: z.ZodString;
        measurement: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"delta">;
            responseId: z.ZodString;
            model: z.ZodNullable<z.ZodString>;
            tokens: z.ZodObject<{
                input: z.ZodNullable<z.ZodNumber>;
                output: z.ZodNullable<z.ZodNumber>;
                cachedInput: z.ZodNullable<z.ZodNumber>;
                cacheWriteInput: z.ZodNullable<z.ZodNumber>;
                reasoningOutput: z.ZodNullable<z.ZodNumber>;
                total: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            cost: z.ZodNullable<z.ZodObject<{
                usd: z.ZodNumber;
                kind: z.ZodEnum<{
                    estimate: "estimate";
                    reported: "reported";
                }>;
            }, z.core.$strict>>;
            source: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"snapshot">;
            scope: z.ZodEnum<{
                turn: "turn";
                conversation: "conversation";
            }>;
            scopeId: z.ZodString;
            epoch: z.ZodString;
            sequence: z.ZodNumber;
            model: z.ZodNullable<z.ZodString>;
            tokens: z.ZodObject<{
                input: z.ZodNullable<z.ZodNumber>;
                output: z.ZodNullable<z.ZodNumber>;
                cachedInput: z.ZodNullable<z.ZodNumber>;
                cacheWriteInput: z.ZodNullable<z.ZodNumber>;
                reasoningOutput: z.ZodNullable<z.ZodNumber>;
                total: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            cost: z.ZodNullable<z.ZodObject<{
                usd: z.ZodNumber;
                kind: z.ZodEnum<{
                    estimate: "estimate";
                    reported: "reported";
                }>;
            }, z.core.$strict>>;
            source: z.ZodString;
        }, z.core.$strict>], "kind">;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"cost">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        conversation: z.ZodString;
        measurement: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"delta">;
            responseId: z.ZodString;
            model: z.ZodNullable<z.ZodString>;
            tokens: z.ZodObject<{
                input: z.ZodNullable<z.ZodNumber>;
                output: z.ZodNullable<z.ZodNumber>;
                cachedInput: z.ZodNullable<z.ZodNumber>;
                cacheWriteInput: z.ZodNullable<z.ZodNumber>;
                reasoningOutput: z.ZodNullable<z.ZodNumber>;
                total: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            cost: z.ZodNullable<z.ZodObject<{
                usd: z.ZodNumber;
                kind: z.ZodEnum<{
                    estimate: "estimate";
                    reported: "reported";
                }>;
            }, z.core.$strict>>;
            source: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"snapshot">;
            scope: z.ZodEnum<{
                turn: "turn";
                conversation: "conversation";
            }>;
            scopeId: z.ZodString;
            epoch: z.ZodString;
            sequence: z.ZodNumber;
            model: z.ZodNullable<z.ZodString>;
            tokens: z.ZodObject<{
                input: z.ZodNullable<z.ZodNumber>;
                output: z.ZodNullable<z.ZodNumber>;
                cachedInput: z.ZodNullable<z.ZodNumber>;
                cacheWriteInput: z.ZodNullable<z.ZodNumber>;
                reasoningOutput: z.ZodNullable<z.ZodNumber>;
                total: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            cost: z.ZodNullable<z.ZodObject<{
                usd: z.ZodNumber;
                kind: z.ZodEnum<{
                    estimate: "estimate";
                    reported: "reported";
                }>;
            }, z.core.$strict>>;
            source: z.ZodString;
        }, z.core.$strict>], "kind">;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"cost">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>;
    record: z.ZodDiscriminatedUnion<[z.ZodObject<{
        workflowName: z.ZodString;
        status: z.ZodEnum<{
            running: "running";
            paused: "paused";
            cancelling: "cancelling";
            recovery_required: "recovery_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        completedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
        error: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        correlations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        paramsSha256: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"run">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        workflowName: z.ZodString;
        status: z.ZodEnum<{
            running: "running";
            paused: "paused";
            cancelling: "cancelling";
            recovery_required: "recovery_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        completedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
        error: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        correlations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        paramsSha256: z.ZodOptional<z.ZodString>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"run">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        stepId: z.ZodString;
        iteration: z.ZodNumber;
        attempt: z.ZodNumber;
        stepKind: z.ZodEnum<{
            dispatch: "dispatch";
            seed: "seed";
            assisted: "assisted";
            authorize: "authorize";
        }>;
        executionId: z.ZodOptional<z.ZodString>;
        phase: z.ZodOptional<z.ZodEnum<{
            running: "running";
            recovery_required: "recovery_required";
            failed: "failed";
            cancelled: "cancelled";
            prepared: "prepared";
            dispatching: "dispatching";
            cancel_requested: "cancel_requested";
            succeeded: "succeeded";
            cancellation_unknown: "cancellation_unknown";
            ended: "ended";
        }>>;
        outcome: z.ZodOptional<z.ZodEnum<{
            recovery_required: "recovery_required";
            failed: "failed";
            cancelled: "cancelled";
            succeeded: "succeeded";
            cancellation_unknown: "cancellation_unknown";
        }>>;
        retryable: z.ZodOptional<z.ZodBoolean>;
        error: z.ZodOptional<z.ZodString>;
        signal: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        runnerRef: z.ZodOptional<z.ZodString>;
        agentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        conversation: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        completedAt: z.ZodOptional<z.ZodISODateTime>;
        usage: z.ZodOptional<z.ZodObject<{
            costUsd: z.ZodNumber;
            inputTokens: z.ZodOptional<z.ZodNumber>;
            outputTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        recovery: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                unknown: "unknown";
                legacy_unrecoverable: "legacy_unrecoverable";
                not_found: "not_found";
                ownership_lost: "ownership_lost";
            }>;
            observedAt: z.ZodISODateTime;
        }, z.core.$strict>>;
        promptSha256: z.ZodOptional<z.ZodString>;
        outputSha256: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"attempt">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        stepId: z.ZodString;
        iteration: z.ZodNumber;
        attempt: z.ZodNumber;
        stepKind: z.ZodEnum<{
            dispatch: "dispatch";
            seed: "seed";
            assisted: "assisted";
            authorize: "authorize";
        }>;
        executionId: z.ZodOptional<z.ZodString>;
        phase: z.ZodOptional<z.ZodEnum<{
            running: "running";
            recovery_required: "recovery_required";
            failed: "failed";
            cancelled: "cancelled";
            prepared: "prepared";
            dispatching: "dispatching";
            cancel_requested: "cancel_requested";
            succeeded: "succeeded";
            cancellation_unknown: "cancellation_unknown";
            ended: "ended";
        }>>;
        outcome: z.ZodOptional<z.ZodEnum<{
            recovery_required: "recovery_required";
            failed: "failed";
            cancelled: "cancelled";
            succeeded: "succeeded";
            cancellation_unknown: "cancellation_unknown";
        }>>;
        retryable: z.ZodOptional<z.ZodBoolean>;
        error: z.ZodOptional<z.ZodString>;
        signal: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        runnerRef: z.ZodOptional<z.ZodString>;
        agentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        conversation: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        completedAt: z.ZodOptional<z.ZodISODateTime>;
        usage: z.ZodOptional<z.ZodObject<{
            costUsd: z.ZodNumber;
            inputTokens: z.ZodOptional<z.ZodNumber>;
            outputTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        recovery: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                unknown: "unknown";
                legacy_unrecoverable: "legacy_unrecoverable";
                not_found: "not_found";
                ownership_lost: "ownership_lost";
            }>;
            observedAt: z.ZodISODateTime;
        }, z.core.$strict>>;
        promptSha256: z.ZodOptional<z.ZodString>;
        outputSha256: z.ZodOptional<z.ZodString>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"attempt">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        callKind: z.ZodEnum<{
            model: "model";
            tool: "tool";
        }>;
        name: z.ZodString;
        namespace: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        conversation: z.ZodString;
        turn: z.ZodOptional<z.ZodString>;
        isError: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
        span: z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"call">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        callKind: z.ZodEnum<{
            model: "model";
            tool: "tool";
        }>;
        name: z.ZodString;
        namespace: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        conversation: z.ZodString;
        turn: z.ZodOptional<z.ZodString>;
        isError: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
        span: z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"call">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        gateKind: z.ZodEnum<{
            human: "human";
            policy: "policy";
        }>;
        status: z.ZodOptional<z.ZodEnum<{
            cancelled: "cancelled";
            pending: "pending";
            resolved: "resolved";
            expired: "expired";
        }>>;
        verdict: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            allow: "allow";
            deny: "deny";
            revise: "revise";
        }>>>;
        decidedBy: z.ZodOptional<z.ZodString>;
        policyRule: z.ZodOptional<z.ZodObject<{
            table: z.ZodString;
            rowId: z.ZodString;
            version: z.ZodNumber;
        }, z.core.$strict>>;
        resolvedAt: z.ZodOptional<z.ZodISODateTime>;
        expiresAt: z.ZodOptional<z.ZodISODateTime>;
        reason: z.ZodOptional<z.ZodString>;
        promptSha256: z.ZodOptional<z.ZodString>;
        payloadSha256: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"gate">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        gateKind: z.ZodEnum<{
            human: "human";
            policy: "policy";
        }>;
        status: z.ZodOptional<z.ZodEnum<{
            cancelled: "cancelled";
            pending: "pending";
            resolved: "resolved";
            expired: "expired";
        }>>;
        verdict: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            allow: "allow";
            deny: "deny";
            revise: "revise";
        }>>>;
        decidedBy: z.ZodOptional<z.ZodString>;
        policyRule: z.ZodOptional<z.ZodObject<{
            table: z.ZodString;
            rowId: z.ZodString;
            version: z.ZodNumber;
        }, z.core.$strict>>;
        resolvedAt: z.ZodOptional<z.ZodISODateTime>;
        expiresAt: z.ZodOptional<z.ZodISODateTime>;
        reason: z.ZodOptional<z.ZodString>;
        promptSha256: z.ZodOptional<z.ZodString>;
        payloadSha256: z.ZodOptional<z.ZodString>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"gate">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodDiscriminatedUnion<[z.ZodObject<{
        artifactKind: z.ZodLiteral<"commit">;
        sha: z.ZodString;
        branch: z.ZodOptional<z.ZodString>;
        reverts: z.ZodOptional<z.ZodString>;
        repo: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"artifact">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        artifactKind: z.ZodLiteral<"commit">;
        sha: z.ZodString;
        branch: z.ZodOptional<z.ZodString>;
        reverts: z.ZodOptional<z.ZodString>;
        repo: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"artifact">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        artifactKind: z.ZodLiteral<"pr">;
        number: z.ZodNumber;
        state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        mergedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
        closedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
        reviewRounds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        checks: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            pending: "pending";
            passing: "passing";
            failing: "failing";
        }>>>;
        repo: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"artifact">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        artifactKind: z.ZodLiteral<"pr">;
        number: z.ZodNumber;
        state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        mergedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
        closedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
        reviewRounds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        checks: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            pending: "pending";
            passing: "passing";
            failing: "failing";
        }>>>;
        repo: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"artifact">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        artifactKind: z.ZodLiteral<"file">;
        path: z.ZodString;
        commit: z.ZodOptional<z.ZodString>;
        lines: z.ZodOptional<z.ZodArray<z.ZodObject<{
            lineStart: z.ZodNumber;
            lineEnd: z.ZodNumber;
        }, z.core.$strict>>>;
        repo: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"artifact">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        artifactKind: z.ZodLiteral<"file">;
        path: z.ZodString;
        commit: z.ZodOptional<z.ZodString>;
        lines: z.ZodOptional<z.ZodArray<z.ZodObject<{
            lineStart: z.ZodNumber;
            lineEnd: z.ZodNumber;
        }, z.core.$strict>>>;
        repo: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"artifact">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>], "artifactKind">, z.ZodObject<{
        conversation: z.ZodString;
        measurement: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"delta">;
            responseId: z.ZodString;
            model: z.ZodNullable<z.ZodString>;
            tokens: z.ZodObject<{
                input: z.ZodNullable<z.ZodNumber>;
                output: z.ZodNullable<z.ZodNumber>;
                cachedInput: z.ZodNullable<z.ZodNumber>;
                cacheWriteInput: z.ZodNullable<z.ZodNumber>;
                reasoningOutput: z.ZodNullable<z.ZodNumber>;
                total: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            cost: z.ZodNullable<z.ZodObject<{
                usd: z.ZodNumber;
                kind: z.ZodEnum<{
                    estimate: "estimate";
                    reported: "reported";
                }>;
            }, z.core.$strict>>;
            source: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"snapshot">;
            scope: z.ZodEnum<{
                turn: "turn";
                conversation: "conversation";
            }>;
            scopeId: z.ZodString;
            epoch: z.ZodString;
            sequence: z.ZodNumber;
            model: z.ZodNullable<z.ZodString>;
            tokens: z.ZodObject<{
                input: z.ZodNullable<z.ZodNumber>;
                output: z.ZodNullable<z.ZodNumber>;
                cachedInput: z.ZodNullable<z.ZodNumber>;
                cacheWriteInput: z.ZodNullable<z.ZodNumber>;
                reasoningOutput: z.ZodNullable<z.ZodNumber>;
                total: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            cost: z.ZodNullable<z.ZodObject<{
                usd: z.ZodNumber;
                kind: z.ZodEnum<{
                    estimate: "estimate";
                    reported: "reported";
                }>;
            }, z.core.$strict>>;
            source: z.ZodString;
        }, z.core.$strict>], "kind">;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"cost">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    } | {
        conversation: z.ZodString;
        measurement: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"delta">;
            responseId: z.ZodString;
            model: z.ZodNullable<z.ZodString>;
            tokens: z.ZodObject<{
                input: z.ZodNullable<z.ZodNumber>;
                output: z.ZodNullable<z.ZodNumber>;
                cachedInput: z.ZodNullable<z.ZodNumber>;
                cacheWriteInput: z.ZodNullable<z.ZodNumber>;
                reasoningOutput: z.ZodNullable<z.ZodNumber>;
                total: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            cost: z.ZodNullable<z.ZodObject<{
                usd: z.ZodNumber;
                kind: z.ZodEnum<{
                    estimate: "estimate";
                    reported: "reported";
                }>;
            }, z.core.$strict>>;
            source: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"snapshot">;
            scope: z.ZodEnum<{
                turn: "turn";
                conversation: "conversation";
            }>;
            scopeId: z.ZodString;
            epoch: z.ZodString;
            sequence: z.ZodNumber;
            model: z.ZodNullable<z.ZodString>;
            tokens: z.ZodObject<{
                input: z.ZodNullable<z.ZodNumber>;
                output: z.ZodNullable<z.ZodNumber>;
                cachedInput: z.ZodNullable<z.ZodNumber>;
                cacheWriteInput: z.ZodNullable<z.ZodNumber>;
                reasoningOutput: z.ZodNullable<z.ZodNumber>;
                total: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            cost: z.ZodNullable<z.ZodObject<{
                usd: z.ZodNumber;
                kind: z.ZodEnum<{
                    estimate: "estimate";
                    reported: "reported";
                }>;
            }, z.core.$strict>>;
            source: z.ZodString;
        }, z.core.$strict>], "kind">;
        span: z.ZodOptional<z.ZodObject<{
            sourceId: z.ZodString;
            byteOffset: z.ZodNumber;
            byteLength: z.ZodNumber;
            contentHash: z.ZodString;
        }, z.core.$strict>>;
        attemptId: z.ZodOptional<z.ZodString>;
        schema: z.ZodLiteral<"titan.trace/v1">;
        kind: z.ZodLiteral<"cost">;
        id: z.ZodString;
        runId: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>], "kind">;
};
/** Producer schemas: unknown keys are rejected. */
declare const TranscriptSpanSchema: z.ZodObject<{
    sourceId: z.ZodString;
    byteOffset: z.ZodNumber;
    byteLength: z.ZodNumber;
    contentHash: z.ZodString;
}, z.core.$strict>;
declare const TraceUsageMeasurementSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"delta">;
    responseId: z.ZodString;
    model: z.ZodNullable<z.ZodString>;
    tokens: z.ZodObject<{
        input: z.ZodNullable<z.ZodNumber>;
        output: z.ZodNullable<z.ZodNumber>;
        cachedInput: z.ZodNullable<z.ZodNumber>;
        cacheWriteInput: z.ZodNullable<z.ZodNumber>;
        reasoningOutput: z.ZodNullable<z.ZodNumber>;
        total: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    cost: z.ZodNullable<z.ZodObject<{
        usd: z.ZodNumber;
        kind: z.ZodEnum<{
            estimate: "estimate";
            reported: "reported";
        }>;
    }, z.core.$strict>>;
    source: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"snapshot">;
    scope: z.ZodEnum<{
        turn: "turn";
        conversation: "conversation";
    }>;
    scopeId: z.ZodString;
    epoch: z.ZodString;
    sequence: z.ZodNumber;
    model: z.ZodNullable<z.ZodString>;
    tokens: z.ZodObject<{
        input: z.ZodNullable<z.ZodNumber>;
        output: z.ZodNullable<z.ZodNumber>;
        cachedInput: z.ZodNullable<z.ZodNumber>;
        cacheWriteInput: z.ZodNullable<z.ZodNumber>;
        reasoningOutput: z.ZodNullable<z.ZodNumber>;
        total: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    cost: z.ZodNullable<z.ZodObject<{
        usd: z.ZodNumber;
        kind: z.ZodEnum<{
            estimate: "estimate";
            reported: "reported";
        }>;
    }, z.core.$strict>>;
    source: z.ZodString;
}, z.core.$strict>], "kind">;
declare const TraceRunSchema: z.ZodObject<{
    workflowName: z.ZodString;
    status: z.ZodEnum<{
        running: "running";
        paused: "paused";
        cancelling: "cancelling";
        recovery_required: "recovery_required";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    completedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    error: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    correlations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    paramsSha256: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"run">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    workflowName: z.ZodString;
    status: z.ZodEnum<{
        running: "running";
        paused: "paused";
        cancelling: "cancelling";
        recovery_required: "recovery_required";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    completedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    error: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    correlations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    paramsSha256: z.ZodOptional<z.ZodString>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"run">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>;
declare const TraceAttemptSchema: z.ZodObject<{
    stepId: z.ZodString;
    iteration: z.ZodNumber;
    attempt: z.ZodNumber;
    stepKind: z.ZodEnum<{
        dispatch: "dispatch";
        seed: "seed";
        assisted: "assisted";
        authorize: "authorize";
    }>;
    executionId: z.ZodOptional<z.ZodString>;
    phase: z.ZodOptional<z.ZodEnum<{
        running: "running";
        recovery_required: "recovery_required";
        failed: "failed";
        cancelled: "cancelled";
        prepared: "prepared";
        dispatching: "dispatching";
        cancel_requested: "cancel_requested";
        succeeded: "succeeded";
        cancellation_unknown: "cancellation_unknown";
        ended: "ended";
    }>>;
    outcome: z.ZodOptional<z.ZodEnum<{
        recovery_required: "recovery_required";
        failed: "failed";
        cancelled: "cancelled";
        succeeded: "succeeded";
        cancellation_unknown: "cancellation_unknown";
    }>>;
    retryable: z.ZodOptional<z.ZodBoolean>;
    error: z.ZodOptional<z.ZodString>;
    signal: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    runnerRef: z.ZodOptional<z.ZodString>;
    agentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    conversation: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    completedAt: z.ZodOptional<z.ZodISODateTime>;
    usage: z.ZodOptional<z.ZodObject<{
        costUsd: z.ZodNumber;
        inputTokens: z.ZodOptional<z.ZodNumber>;
        outputTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    recovery: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            unknown: "unknown";
            legacy_unrecoverable: "legacy_unrecoverable";
            not_found: "not_found";
            ownership_lost: "ownership_lost";
        }>;
        observedAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    promptSha256: z.ZodOptional<z.ZodString>;
    outputSha256: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"attempt">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    stepId: z.ZodString;
    iteration: z.ZodNumber;
    attempt: z.ZodNumber;
    stepKind: z.ZodEnum<{
        dispatch: "dispatch";
        seed: "seed";
        assisted: "assisted";
        authorize: "authorize";
    }>;
    executionId: z.ZodOptional<z.ZodString>;
    phase: z.ZodOptional<z.ZodEnum<{
        running: "running";
        recovery_required: "recovery_required";
        failed: "failed";
        cancelled: "cancelled";
        prepared: "prepared";
        dispatching: "dispatching";
        cancel_requested: "cancel_requested";
        succeeded: "succeeded";
        cancellation_unknown: "cancellation_unknown";
        ended: "ended";
    }>>;
    outcome: z.ZodOptional<z.ZodEnum<{
        recovery_required: "recovery_required";
        failed: "failed";
        cancelled: "cancelled";
        succeeded: "succeeded";
        cancellation_unknown: "cancellation_unknown";
    }>>;
    retryable: z.ZodOptional<z.ZodBoolean>;
    error: z.ZodOptional<z.ZodString>;
    signal: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    runnerRef: z.ZodOptional<z.ZodString>;
    agentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    conversation: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    completedAt: z.ZodOptional<z.ZodISODateTime>;
    usage: z.ZodOptional<z.ZodObject<{
        costUsd: z.ZodNumber;
        inputTokens: z.ZodOptional<z.ZodNumber>;
        outputTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    recovery: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            unknown: "unknown";
            legacy_unrecoverable: "legacy_unrecoverable";
            not_found: "not_found";
            ownership_lost: "ownership_lost";
        }>;
        observedAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    promptSha256: z.ZodOptional<z.ZodString>;
    outputSha256: z.ZodOptional<z.ZodString>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"attempt">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>;
declare const TraceCallSchema: z.ZodObject<{
    callKind: z.ZodEnum<{
        model: "model";
        tool: "tool";
    }>;
    name: z.ZodString;
    namespace: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    conversation: z.ZodString;
    turn: z.ZodOptional<z.ZodString>;
    isError: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    span: z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"call">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    callKind: z.ZodEnum<{
        model: "model";
        tool: "tool";
    }>;
    name: z.ZodString;
    namespace: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    conversation: z.ZodString;
    turn: z.ZodOptional<z.ZodString>;
    isError: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    span: z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"call">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>;
declare const TraceGateSchema: z.ZodObject<{
    gateKind: z.ZodEnum<{
        human: "human";
        policy: "policy";
    }>;
    status: z.ZodOptional<z.ZodEnum<{
        cancelled: "cancelled";
        pending: "pending";
        resolved: "resolved";
        expired: "expired";
    }>>;
    verdict: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        allow: "allow";
        deny: "deny";
        revise: "revise";
    }>>>;
    decidedBy: z.ZodOptional<z.ZodString>;
    policyRule: z.ZodOptional<z.ZodObject<{
        table: z.ZodString;
        rowId: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    resolvedAt: z.ZodOptional<z.ZodISODateTime>;
    expiresAt: z.ZodOptional<z.ZodISODateTime>;
    reason: z.ZodOptional<z.ZodString>;
    promptSha256: z.ZodOptional<z.ZodString>;
    payloadSha256: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"gate">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    gateKind: z.ZodEnum<{
        human: "human";
        policy: "policy";
    }>;
    status: z.ZodOptional<z.ZodEnum<{
        cancelled: "cancelled";
        pending: "pending";
        resolved: "resolved";
        expired: "expired";
    }>>;
    verdict: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        allow: "allow";
        deny: "deny";
        revise: "revise";
    }>>>;
    decidedBy: z.ZodOptional<z.ZodString>;
    policyRule: z.ZodOptional<z.ZodObject<{
        table: z.ZodString;
        rowId: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    resolvedAt: z.ZodOptional<z.ZodISODateTime>;
    expiresAt: z.ZodOptional<z.ZodISODateTime>;
    reason: z.ZodOptional<z.ZodString>;
    promptSha256: z.ZodOptional<z.ZodString>;
    payloadSha256: z.ZodOptional<z.ZodString>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"gate">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>;
declare const TraceArtifactSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    artifactKind: z.ZodLiteral<"commit">;
    sha: z.ZodString;
    branch: z.ZodOptional<z.ZodString>;
    reverts: z.ZodOptional<z.ZodString>;
    repo: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"artifact">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    artifactKind: z.ZodLiteral<"commit">;
    sha: z.ZodString;
    branch: z.ZodOptional<z.ZodString>;
    reverts: z.ZodOptional<z.ZodString>;
    repo: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"artifact">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    artifactKind: z.ZodLiteral<"pr">;
    number: z.ZodNumber;
    state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    mergedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    closedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    reviewRounds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    checks: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        pending: "pending";
        passing: "passing";
        failing: "failing";
    }>>>;
    repo: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"artifact">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    artifactKind: z.ZodLiteral<"pr">;
    number: z.ZodNumber;
    state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    mergedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    closedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    reviewRounds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    checks: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        pending: "pending";
        passing: "passing";
        failing: "failing";
    }>>>;
    repo: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"artifact">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    artifactKind: z.ZodLiteral<"file">;
    path: z.ZodString;
    commit: z.ZodOptional<z.ZodString>;
    lines: z.ZodOptional<z.ZodArray<z.ZodObject<{
        lineStart: z.ZodNumber;
        lineEnd: z.ZodNumber;
    }, z.core.$strict>>>;
    repo: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"artifact">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    artifactKind: z.ZodLiteral<"file">;
    path: z.ZodString;
    commit: z.ZodOptional<z.ZodString>;
    lines: z.ZodOptional<z.ZodArray<z.ZodObject<{
        lineStart: z.ZodNumber;
        lineEnd: z.ZodNumber;
    }, z.core.$strict>>>;
    repo: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"artifact">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>], "artifactKind">;
declare const TraceCostSchema: z.ZodObject<{
    conversation: z.ZodString;
    measurement: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"delta">;
        responseId: z.ZodString;
        model: z.ZodNullable<z.ZodString>;
        tokens: z.ZodObject<{
            input: z.ZodNullable<z.ZodNumber>;
            output: z.ZodNullable<z.ZodNumber>;
            cachedInput: z.ZodNullable<z.ZodNumber>;
            cacheWriteInput: z.ZodNullable<z.ZodNumber>;
            reasoningOutput: z.ZodNullable<z.ZodNumber>;
            total: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        cost: z.ZodNullable<z.ZodObject<{
            usd: z.ZodNumber;
            kind: z.ZodEnum<{
                estimate: "estimate";
                reported: "reported";
            }>;
        }, z.core.$strict>>;
        source: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"snapshot">;
        scope: z.ZodEnum<{
            turn: "turn";
            conversation: "conversation";
        }>;
        scopeId: z.ZodString;
        epoch: z.ZodString;
        sequence: z.ZodNumber;
        model: z.ZodNullable<z.ZodString>;
        tokens: z.ZodObject<{
            input: z.ZodNullable<z.ZodNumber>;
            output: z.ZodNullable<z.ZodNumber>;
            cachedInput: z.ZodNullable<z.ZodNumber>;
            cacheWriteInput: z.ZodNullable<z.ZodNumber>;
            reasoningOutput: z.ZodNullable<z.ZodNumber>;
            total: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        cost: z.ZodNullable<z.ZodObject<{
            usd: z.ZodNumber;
            kind: z.ZodEnum<{
                estimate: "estimate";
                reported: "reported";
            }>;
        }, z.core.$strict>>;
        source: z.ZodString;
    }, z.core.$strict>], "kind">;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"cost">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    conversation: z.ZodString;
    measurement: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"delta">;
        responseId: z.ZodString;
        model: z.ZodNullable<z.ZodString>;
        tokens: z.ZodObject<{
            input: z.ZodNullable<z.ZodNumber>;
            output: z.ZodNullable<z.ZodNumber>;
            cachedInput: z.ZodNullable<z.ZodNumber>;
            cacheWriteInput: z.ZodNullable<z.ZodNumber>;
            reasoningOutput: z.ZodNullable<z.ZodNumber>;
            total: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        cost: z.ZodNullable<z.ZodObject<{
            usd: z.ZodNumber;
            kind: z.ZodEnum<{
                estimate: "estimate";
                reported: "reported";
            }>;
        }, z.core.$strict>>;
        source: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"snapshot">;
        scope: z.ZodEnum<{
            turn: "turn";
            conversation: "conversation";
        }>;
        scopeId: z.ZodString;
        epoch: z.ZodString;
        sequence: z.ZodNumber;
        model: z.ZodNullable<z.ZodString>;
        tokens: z.ZodObject<{
            input: z.ZodNullable<z.ZodNumber>;
            output: z.ZodNullable<z.ZodNumber>;
            cachedInput: z.ZodNullable<z.ZodNumber>;
            cacheWriteInput: z.ZodNullable<z.ZodNumber>;
            reasoningOutput: z.ZodNullable<z.ZodNumber>;
            total: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        cost: z.ZodNullable<z.ZodObject<{
            usd: z.ZodNumber;
            kind: z.ZodEnum<{
                estimate: "estimate";
                reported: "reported";
            }>;
        }, z.core.$strict>>;
        source: z.ZodString;
    }, z.core.$strict>], "kind">;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"cost">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>;
declare const TraceRecordSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    workflowName: z.ZodString;
    status: z.ZodEnum<{
        running: "running";
        paused: "paused";
        cancelling: "cancelling";
        recovery_required: "recovery_required";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    completedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    error: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    correlations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    paramsSha256: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"run">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    workflowName: z.ZodString;
    status: z.ZodEnum<{
        running: "running";
        paused: "paused";
        cancelling: "cancelling";
        recovery_required: "recovery_required";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    completedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    error: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    correlations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    paramsSha256: z.ZodOptional<z.ZodString>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"run">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    stepId: z.ZodString;
    iteration: z.ZodNumber;
    attempt: z.ZodNumber;
    stepKind: z.ZodEnum<{
        dispatch: "dispatch";
        seed: "seed";
        assisted: "assisted";
        authorize: "authorize";
    }>;
    executionId: z.ZodOptional<z.ZodString>;
    phase: z.ZodOptional<z.ZodEnum<{
        running: "running";
        recovery_required: "recovery_required";
        failed: "failed";
        cancelled: "cancelled";
        prepared: "prepared";
        dispatching: "dispatching";
        cancel_requested: "cancel_requested";
        succeeded: "succeeded";
        cancellation_unknown: "cancellation_unknown";
        ended: "ended";
    }>>;
    outcome: z.ZodOptional<z.ZodEnum<{
        recovery_required: "recovery_required";
        failed: "failed";
        cancelled: "cancelled";
        succeeded: "succeeded";
        cancellation_unknown: "cancellation_unknown";
    }>>;
    retryable: z.ZodOptional<z.ZodBoolean>;
    error: z.ZodOptional<z.ZodString>;
    signal: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    runnerRef: z.ZodOptional<z.ZodString>;
    agentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    conversation: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    completedAt: z.ZodOptional<z.ZodISODateTime>;
    usage: z.ZodOptional<z.ZodObject<{
        costUsd: z.ZodNumber;
        inputTokens: z.ZodOptional<z.ZodNumber>;
        outputTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    recovery: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            unknown: "unknown";
            legacy_unrecoverable: "legacy_unrecoverable";
            not_found: "not_found";
            ownership_lost: "ownership_lost";
        }>;
        observedAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    promptSha256: z.ZodOptional<z.ZodString>;
    outputSha256: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"attempt">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    stepId: z.ZodString;
    iteration: z.ZodNumber;
    attempt: z.ZodNumber;
    stepKind: z.ZodEnum<{
        dispatch: "dispatch";
        seed: "seed";
        assisted: "assisted";
        authorize: "authorize";
    }>;
    executionId: z.ZodOptional<z.ZodString>;
    phase: z.ZodOptional<z.ZodEnum<{
        running: "running";
        recovery_required: "recovery_required";
        failed: "failed";
        cancelled: "cancelled";
        prepared: "prepared";
        dispatching: "dispatching";
        cancel_requested: "cancel_requested";
        succeeded: "succeeded";
        cancellation_unknown: "cancellation_unknown";
        ended: "ended";
    }>>;
    outcome: z.ZodOptional<z.ZodEnum<{
        recovery_required: "recovery_required";
        failed: "failed";
        cancelled: "cancelled";
        succeeded: "succeeded";
        cancellation_unknown: "cancellation_unknown";
    }>>;
    retryable: z.ZodOptional<z.ZodBoolean>;
    error: z.ZodOptional<z.ZodString>;
    signal: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    runnerRef: z.ZodOptional<z.ZodString>;
    agentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    conversation: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    completedAt: z.ZodOptional<z.ZodISODateTime>;
    usage: z.ZodOptional<z.ZodObject<{
        costUsd: z.ZodNumber;
        inputTokens: z.ZodOptional<z.ZodNumber>;
        outputTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    recovery: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            unknown: "unknown";
            legacy_unrecoverable: "legacy_unrecoverable";
            not_found: "not_found";
            ownership_lost: "ownership_lost";
        }>;
        observedAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    promptSha256: z.ZodOptional<z.ZodString>;
    outputSha256: z.ZodOptional<z.ZodString>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"attempt">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    callKind: z.ZodEnum<{
        model: "model";
        tool: "tool";
    }>;
    name: z.ZodString;
    namespace: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    conversation: z.ZodString;
    turn: z.ZodOptional<z.ZodString>;
    isError: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    span: z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"call">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    callKind: z.ZodEnum<{
        model: "model";
        tool: "tool";
    }>;
    name: z.ZodString;
    namespace: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    conversation: z.ZodString;
    turn: z.ZodOptional<z.ZodString>;
    isError: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    span: z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"call">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    gateKind: z.ZodEnum<{
        human: "human";
        policy: "policy";
    }>;
    status: z.ZodOptional<z.ZodEnum<{
        cancelled: "cancelled";
        pending: "pending";
        resolved: "resolved";
        expired: "expired";
    }>>;
    verdict: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        allow: "allow";
        deny: "deny";
        revise: "revise";
    }>>>;
    decidedBy: z.ZodOptional<z.ZodString>;
    policyRule: z.ZodOptional<z.ZodObject<{
        table: z.ZodString;
        rowId: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    resolvedAt: z.ZodOptional<z.ZodISODateTime>;
    expiresAt: z.ZodOptional<z.ZodISODateTime>;
    reason: z.ZodOptional<z.ZodString>;
    promptSha256: z.ZodOptional<z.ZodString>;
    payloadSha256: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"gate">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    gateKind: z.ZodEnum<{
        human: "human";
        policy: "policy";
    }>;
    status: z.ZodOptional<z.ZodEnum<{
        cancelled: "cancelled";
        pending: "pending";
        resolved: "resolved";
        expired: "expired";
    }>>;
    verdict: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        allow: "allow";
        deny: "deny";
        revise: "revise";
    }>>>;
    decidedBy: z.ZodOptional<z.ZodString>;
    policyRule: z.ZodOptional<z.ZodObject<{
        table: z.ZodString;
        rowId: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    resolvedAt: z.ZodOptional<z.ZodISODateTime>;
    expiresAt: z.ZodOptional<z.ZodISODateTime>;
    reason: z.ZodOptional<z.ZodString>;
    promptSha256: z.ZodOptional<z.ZodString>;
    payloadSha256: z.ZodOptional<z.ZodString>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"gate">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodDiscriminatedUnion<[z.ZodObject<{
    artifactKind: z.ZodLiteral<"commit">;
    sha: z.ZodString;
    branch: z.ZodOptional<z.ZodString>;
    reverts: z.ZodOptional<z.ZodString>;
    repo: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"artifact">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    artifactKind: z.ZodLiteral<"commit">;
    sha: z.ZodString;
    branch: z.ZodOptional<z.ZodString>;
    reverts: z.ZodOptional<z.ZodString>;
    repo: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"artifact">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    artifactKind: z.ZodLiteral<"pr">;
    number: z.ZodNumber;
    state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    mergedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    closedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    reviewRounds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    checks: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        pending: "pending";
        passing: "passing";
        failing: "failing";
    }>>>;
    repo: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"artifact">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    artifactKind: z.ZodLiteral<"pr">;
    number: z.ZodNumber;
    state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    mergedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    closedAt: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    reviewRounds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    checks: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        pending: "pending";
        passing: "passing";
        failing: "failing";
    }>>>;
    repo: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"artifact">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    artifactKind: z.ZodLiteral<"file">;
    path: z.ZodString;
    commit: z.ZodOptional<z.ZodString>;
    lines: z.ZodOptional<z.ZodArray<z.ZodObject<{
        lineStart: z.ZodNumber;
        lineEnd: z.ZodNumber;
    }, z.core.$strict>>>;
    repo: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"artifact">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    artifactKind: z.ZodLiteral<"file">;
    path: z.ZodString;
    commit: z.ZodOptional<z.ZodString>;
    lines: z.ZodOptional<z.ZodArray<z.ZodObject<{
        lineStart: z.ZodNumber;
        lineEnd: z.ZodNumber;
    }, z.core.$strict>>>;
    repo: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"artifact">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>], "artifactKind">, z.ZodObject<{
    conversation: z.ZodString;
    measurement: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"delta">;
        responseId: z.ZodString;
        model: z.ZodNullable<z.ZodString>;
        tokens: z.ZodObject<{
            input: z.ZodNullable<z.ZodNumber>;
            output: z.ZodNullable<z.ZodNumber>;
            cachedInput: z.ZodNullable<z.ZodNumber>;
            cacheWriteInput: z.ZodNullable<z.ZodNumber>;
            reasoningOutput: z.ZodNullable<z.ZodNumber>;
            total: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        cost: z.ZodNullable<z.ZodObject<{
            usd: z.ZodNumber;
            kind: z.ZodEnum<{
                estimate: "estimate";
                reported: "reported";
            }>;
        }, z.core.$strict>>;
        source: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"snapshot">;
        scope: z.ZodEnum<{
            turn: "turn";
            conversation: "conversation";
        }>;
        scopeId: z.ZodString;
        epoch: z.ZodString;
        sequence: z.ZodNumber;
        model: z.ZodNullable<z.ZodString>;
        tokens: z.ZodObject<{
            input: z.ZodNullable<z.ZodNumber>;
            output: z.ZodNullable<z.ZodNumber>;
            cachedInput: z.ZodNullable<z.ZodNumber>;
            cacheWriteInput: z.ZodNullable<z.ZodNumber>;
            reasoningOutput: z.ZodNullable<z.ZodNumber>;
            total: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        cost: z.ZodNullable<z.ZodObject<{
            usd: z.ZodNumber;
            kind: z.ZodEnum<{
                estimate: "estimate";
                reported: "reported";
            }>;
        }, z.core.$strict>>;
        source: z.ZodString;
    }, z.core.$strict>], "kind">;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"cost">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
} | {
    conversation: z.ZodString;
    measurement: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"delta">;
        responseId: z.ZodString;
        model: z.ZodNullable<z.ZodString>;
        tokens: z.ZodObject<{
            input: z.ZodNullable<z.ZodNumber>;
            output: z.ZodNullable<z.ZodNumber>;
            cachedInput: z.ZodNullable<z.ZodNumber>;
            cacheWriteInput: z.ZodNullable<z.ZodNumber>;
            reasoningOutput: z.ZodNullable<z.ZodNumber>;
            total: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        cost: z.ZodNullable<z.ZodObject<{
            usd: z.ZodNumber;
            kind: z.ZodEnum<{
                estimate: "estimate";
                reported: "reported";
            }>;
        }, z.core.$strict>>;
        source: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"snapshot">;
        scope: z.ZodEnum<{
            turn: "turn";
            conversation: "conversation";
        }>;
        scopeId: z.ZodString;
        epoch: z.ZodString;
        sequence: z.ZodNumber;
        model: z.ZodNullable<z.ZodString>;
        tokens: z.ZodObject<{
            input: z.ZodNullable<z.ZodNumber>;
            output: z.ZodNullable<z.ZodNumber>;
            cachedInput: z.ZodNullable<z.ZodNumber>;
            cacheWriteInput: z.ZodNullable<z.ZodNumber>;
            reasoningOutput: z.ZodNullable<z.ZodNumber>;
            total: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        cost: z.ZodNullable<z.ZodObject<{
            usd: z.ZodNumber;
            kind: z.ZodEnum<{
                estimate: "estimate";
                reported: "reported";
            }>;
        }, z.core.$strict>>;
        source: z.ZodString;
    }, z.core.$strict>], "kind">;
    span: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        byteOffset: z.ZodNumber;
        byteLength: z.ZodNumber;
        contentHash: z.ZodString;
    }, z.core.$strict>>;
    attemptId: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodLiteral<"cost">;
    id: z.ZodString;
    runId: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>], "kind">;
/** The fields every kind shares; extra keys pass so any record can be read as its envelope. */
declare const TraceEnvelopeSchema: z.ZodObject<{
    schema: z.ZodLiteral<"titan.trace/v1">;
    kind: z.ZodEnum<{
        run: "run";
        attempt: "attempt";
        call: "call";
        gate: "gate";
        artifact: "artifact";
        cost: "cost";
    }>;
    id: z.ZodString;
    runId: z.ZodString;
    attemptId: z.ZodOptional<z.ZodString>;
    at: z.ZodISODateTime;
}, z.core.$loose>;
type TranscriptSpan = z.infer<typeof TranscriptSpanSchema>;
type TraceEnvelope = z.infer<typeof TraceEnvelopeSchema>;
type TraceRun = z.infer<typeof TraceRunSchema>;
type TraceAttempt = z.infer<typeof TraceAttemptSchema>;
type TraceCall = z.infer<typeof TraceCallSchema>;
type TraceGate = z.infer<typeof TraceGateSchema>;
type TraceArtifact = z.infer<typeof TraceArtifactSchema>;
type TraceCost = z.infer<typeof TraceCostSchema>;
type TraceRecord = z.infer<typeof TraceRecordSchema>;
type TraceRecordKind = TraceRecord["kind"];
/** A record of a kind this version does not know, kept whole for a later reader. */
interface UnknownTraceRecord {
    kind: "unknown";
    value: unknown;
}
type LooseTraceRecord = z.infer<typeof loose.record> | UnknownTraceRecord;
declare function parseTraceRecord(value: unknown): TraceRecord;
/** Consumer parse: unknown keys are kept, an unknown kind comes back as `{ kind: "unknown" }`, a known kind must still be valid. */
declare function parseTraceRecordLoose(value: unknown): LooseTraceRecord;

export { ATTEMPT_ID_PATTERN, CALL_ID_PATTERN, COMMIT_ID_PATTERN, COMMIT_SHA_PATTERN, CONVERSATION_REF_PATTERN, COST_ID_PATTERN, FILE_ID_PATTERN, HUMAN_GATE_ID_PATTERN, type LooseTraceRecord, POLICY_GATE_ID_PATTERN, PR_ID_PATTERN, REDACTED_LOCAL_VALUE, REPO_PATTERN, type RedactTraceOptions, SHA256_PATTERN, TRACE_ARTIFACT_KINDS, TRACE_CHECK_STATES, TRACE_FIELD_PRIVACY, TRACE_GATE_STATUSES, TRACE_GATE_VERDICTS, TRACE_RECORD_KINDS, TRACE_RUN_STATUSES, TRACE_SCHEMA_VERSION, TRACE_STEP_KINDS, TURN_REF_PATTERN, type TraceArtifact, TraceArtifactSchema, type TraceAttempt, TraceAttemptSchema, type TraceCall, TraceCallSchema, type TraceCost, TraceCostSchema, type TraceEnvelope, TraceEnvelopeSchema, type TraceGate, TraceGateSchema, type TraceParseMode, type TracePrivacyClass, type TracePrivacyScope, type TraceRecord, type TraceRecordKind, TraceRecordSchema, type TraceRun, TraceRunSchema, TraceUsageMeasurementSchema, type TranscriptSpan, TranscriptSpanSchema, type UnknownTraceRecord, commitRef, costId, parseTraceRecord, parseTraceRecordLoose, policyGateId, redactTraceRecord, tracePrivacyScope };
