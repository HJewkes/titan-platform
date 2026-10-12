import { z } from 'zod';

/**
 * A byte-compatible subset of the Vercel AI SDK `UIMessagePart` union, vendored
 * rather than imported: tier 0 carries no runtime dependency beyond zod as a
 * peer. `ai` is a devDependency only, and `ai-compat.test.ts` round-trips a real
 * `UIMessage` through these schemas so the subset cannot drift silently.
 *
 * Verified against ai@7.0.102.
 */
type PartStreamState = "streaming" | "done";
/**
 * Opaque to this package and preserved verbatim. Anthropic's thinking signature
 * rides here, and a resumed run breaks if a persistence layer drops it.
 */
type ProviderMetadata = Record<string, Record<string, unknown>>;
interface TextPart {
    type: "text";
    text: string;
    state?: PartStreamState;
    providerMetadata?: ProviderMetadata;
}
interface ReasoningPart {
    type: "reasoning";
    id?: string;
    text: string;
    state?: PartStreamState;
    providerMetadata?: ProviderMetadata;
}
interface SourceUrlPart {
    type: "source-url";
    sourceId: string;
    url: string;
    title?: string;
}
interface SourceDocumentPart {
    type: "source-document";
    sourceId: string;
    mediaType: string;
    title: string;
    filename?: string;
}
interface FilePart {
    type: "file";
    mediaType: string;
    filename?: string;
    url: string;
}
interface StepStartPart {
    type: "step-start";
}
/**
 * The approval state machine the AI SDK already ships. `approval-requested` is
 * the inbound permission prompt, `approval-responded` the verdict, and
 * `output-denied` the refusal — no titan part type is added for any of them.
 */
type ToolPartState = "input-streaming" | "input-available" | "approval-requested" | "approval-responded" | "output-available" | "output-error" | "output-denied";
interface ToolApproval {
    id: string;
    approved?: boolean;
    descriptor?: unknown;
    reason?: string;
    signature?: string;
}
interface ToolPart {
    type: `tool-${string}`;
    toolCallId: string;
    state: ToolPartState;
    input?: unknown;
    output?: unknown;
    errorText?: string;
    approval?: ToolApproval;
    providerExecuted?: boolean;
    callProviderMetadata?: ProviderMetadata;
    resultProviderMetadata?: ProviderMetadata;
}
interface DataPart {
    type: `data-${string}`;
    id?: string;
    data: unknown;
}
type ChatPart = TextPart | ReasoningPart | SourceUrlPart | SourceDocumentPart | FilePart | StepStartPart | ToolPart | DataPart;
/**
 * A Claude Code channel turns every `meta` entry into an attribute and silently
 * drops any key that is not an identifier. A `data-` suffix therefore may not
 * contain a hyphen, or the part loses its routing context with no error.
 */
declare const DATA_PART_KEY_PATTERN: RegExp;
declare function isDataPartType(type: string): type is `data-${string}`;
declare function isToolPartType(type: string): type is `tool-${string}`;
declare const providerMetadata: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>;
declare const textPart: z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    state: z.ZodOptional<z.ZodEnum<{
        streaming: "streaming";
        done: "done";
    }>>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strip>;
declare const reasoningPart: z.ZodObject<{
    type: z.ZodLiteral<"reasoning">;
    id: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    state: z.ZodOptional<z.ZodEnum<{
        streaming: "streaming";
        done: "done";
    }>>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strip>;
declare const sourceUrlPart: z.ZodObject<{
    type: z.ZodLiteral<"source-url">;
    sourceId: z.ZodString;
    url: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const sourceDocumentPart: z.ZodObject<{
    type: z.ZodLiteral<"source-document">;
    sourceId: z.ZodString;
    mediaType: z.ZodString;
    title: z.ZodString;
    filename: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const filePart: z.ZodObject<{
    type: z.ZodLiteral<"file">;
    mediaType: z.ZodString;
    filename: z.ZodOptional<z.ZodString>;
    url: z.ZodString;
}, z.core.$strip>;
declare const stepStartPart: z.ZodObject<{
    type: z.ZodLiteral<"step-start">;
}, z.core.$strip>;
declare const toolApproval: z.ZodObject<{
    id: z.ZodString;
    approved: z.ZodOptional<z.ZodBoolean>;
    descriptor: z.ZodOptional<z.ZodUnknown>;
    reason: z.ZodOptional<z.ZodString>;
    signature: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const toolPart: z.ZodObject<{
    type: z.ZodCustom<`tool-${string}`, `tool-${string}`>;
    toolCallId: z.ZodString;
    state: z.ZodEnum<{
        "input-streaming": "input-streaming";
        "input-available": "input-available";
        "approval-requested": "approval-requested";
        "approval-responded": "approval-responded";
        "output-available": "output-available";
        "output-error": "output-error";
        "output-denied": "output-denied";
    }>;
    input: z.ZodOptional<z.ZodUnknown>;
    output: z.ZodOptional<z.ZodUnknown>;
    errorText: z.ZodOptional<z.ZodString>;
    approval: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        approved: z.ZodOptional<z.ZodBoolean>;
        descriptor: z.ZodOptional<z.ZodUnknown>;
        reason: z.ZodOptional<z.ZodString>;
        signature: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    providerExecuted: z.ZodOptional<z.ZodBoolean>;
    callProviderMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    resultProviderMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strip>;
/** Anything titan-specific rides here; `data` stays `unknown` so the protocol never owns a payload. */
declare const dataPart: z.ZodObject<{
    type: z.ZodCustom<`data-${string}`, `data-${string}`>;
    id: z.ZodOptional<z.ZodString>;
    data: z.ZodUnknown;
}, z.core.$strip>;
declare const chatPart: z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    state: z.ZodOptional<z.ZodEnum<{
        streaming: "streaming";
        done: "done";
    }>>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning">;
    id: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    state: z.ZodOptional<z.ZodEnum<{
        streaming: "streaming";
        done: "done";
    }>>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"source-url">;
    sourceId: z.ZodString;
    url: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"source-document">;
    sourceId: z.ZodString;
    mediaType: z.ZodString;
    title: z.ZodString;
    filename: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"file">;
    mediaType: z.ZodString;
    filename: z.ZodOptional<z.ZodString>;
    url: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"step-start">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodCustom<`tool-${string}`, `tool-${string}`>;
    toolCallId: z.ZodString;
    state: z.ZodEnum<{
        "input-streaming": "input-streaming";
        "input-available": "input-available";
        "approval-requested": "approval-requested";
        "approval-responded": "approval-responded";
        "output-available": "output-available";
        "output-error": "output-error";
        "output-denied": "output-denied";
    }>;
    input: z.ZodOptional<z.ZodUnknown>;
    output: z.ZodOptional<z.ZodUnknown>;
    errorText: z.ZodOptional<z.ZodString>;
    approval: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        approved: z.ZodOptional<z.ZodBoolean>;
        descriptor: z.ZodOptional<z.ZodUnknown>;
        reason: z.ZodOptional<z.ZodString>;
        signature: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    providerExecuted: z.ZodOptional<z.ZodBoolean>;
    callProviderMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    resultProviderMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodCustom<`data-${string}`, `data-${string}`>;
    id: z.ZodOptional<z.ZodString>;
    data: z.ZodUnknown;
}, z.core.$strip>]>;

/**
 * The envelope is everything `UIMessage` genuinely lacks: a thread, a
 * participant beyond the three roles, per-recipient delivery, and broker-set
 * provenance. Strip those four fields and a `ChatMessage` is a plain
 * `UIMessage`, which is the whole point of adding no part types.
 */
/** The AI SDK's roles, verbatim. `tool` is not one: tool results ride `tool-*` parts. */
type MessageRole = "system" | "user" | "assistant";
/** `kind` picks the renderer's affordances, never its parsing. */
type ThreadKind = "coach" | "agent-run" | "bus" | "device" | "harness";
type ParticipantKind = "human" | "agent" | "device" | "service";
type AddressScheme = "telegram" | "imessage" | "agent-chat" | "mcp";
interface ParticipantAddress {
    scheme: AddressScheme;
    value: string;
}
/** Identity lives in `id`. A role is a rendering hint, never an identity. */
interface Participant {
    id: string;
    role: MessageRole;
    displayName: string;
    kind: ParticipantKind;
    address?: ParticipantAddress;
}
interface ChatThread {
    id: string;
    kind: ThreadKind;
    title?: string;
    participants: Participant[];
    /** ISO-8601 with milliseconds, matching the shape hitl's GateRecord writes. */
    createdAt: string;
}
/**
 * `held` means the message reached an inbox that nothing is watching, which is
 * why per-recipient state cannot collapse to a single status on the message.
 */
type DeliveryStatus = "pending" | "accepted" | "delivered" | "read" | "held" | "undeliverable";
interface DeliveryState {
    participantId: string;
    status: DeliveryStatus;
    at: string;
    reason?: string;
}
/**
 * Broker-set only. `endorsedBy: "human"` means a human read those exact words
 * and approved sending them; no client payload may reach it, which is why
 * `inboundChatMessage` omits the field rather than validating it.
 */
type Provenance = {
    authored: "human";
} | {
    authored: "agent";
} | {
    authored: "agent";
    endorsedBy: "human";
    attestedBy: string;
};
interface ChatMessage {
    id: string;
    threadId: string;
    authorId: string;
    role: MessageRole;
    createdAt: string;
    parts: ChatPart[];
    metadata?: Record<string, unknown>;
    inReplyTo?: string;
    provenance?: Provenance;
    /** One entry per recipient. Absent means "not tracked", never "delivered". */
    delivery?: DeliveryState[];
}
declare const messageRole: z.ZodEnum<{
    system: "system";
    user: "user";
    assistant: "assistant";
}>;
declare const threadKind: z.ZodEnum<{
    coach: "coach";
    "agent-run": "agent-run";
    bus: "bus";
    device: "device";
    harness: "harness";
}>;
declare const participantKind: z.ZodEnum<{
    device: "device";
    human: "human";
    agent: "agent";
    service: "service";
}>;
declare const addressScheme: z.ZodEnum<{
    telegram: "telegram";
    imessage: "imessage";
    "agent-chat": "agent-chat";
    mcp: "mcp";
}>;
declare const participant: z.ZodObject<{
    id: z.ZodString;
    role: z.ZodEnum<{
        system: "system";
        user: "user";
        assistant: "assistant";
    }>;
    displayName: z.ZodString;
    kind: z.ZodEnum<{
        device: "device";
        human: "human";
        agent: "agent";
        service: "service";
    }>;
    address: z.ZodOptional<z.ZodObject<{
        scheme: z.ZodEnum<{
            telegram: "telegram";
            imessage: "imessage";
            "agent-chat": "agent-chat";
            mcp: "mcp";
        }>;
        value: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const chatThread: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
        coach: "coach";
        "agent-run": "agent-run";
        bus: "bus";
        device: "device";
        harness: "harness";
    }>;
    title: z.ZodOptional<z.ZodString>;
    participants: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        role: z.ZodEnum<{
            system: "system";
            user: "user";
            assistant: "assistant";
        }>;
        displayName: z.ZodString;
        kind: z.ZodEnum<{
            device: "device";
            human: "human";
            agent: "agent";
            service: "service";
        }>;
        address: z.ZodOptional<z.ZodObject<{
            scheme: z.ZodEnum<{
                telegram: "telegram";
                imessage: "imessage";
                "agent-chat": "agent-chat";
                mcp: "mcp";
            }>;
            value: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    createdAt: z.ZodString;
}, z.core.$strip>;
declare const deliveryStatus: z.ZodEnum<{
    pending: "pending";
    accepted: "accepted";
    delivered: "delivered";
    read: "read";
    held: "held";
    undeliverable: "undeliverable";
}>;
declare const deliveryState: z.ZodObject<{
    participantId: z.ZodString;
    status: z.ZodEnum<{
        pending: "pending";
        accepted: "accepted";
        delivered: "delivered";
        read: "read";
        held: "held";
        undeliverable: "undeliverable";
    }>;
    at: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const provenance: z.ZodUnion<readonly [z.ZodObject<{
    authored: z.ZodLiteral<"human">;
}, z.core.$strip>, z.ZodObject<{
    authored: z.ZodLiteral<"agent">;
}, z.core.$strip>, z.ZodObject<{
    authored: z.ZodLiteral<"agent">;
    endorsedBy: z.ZodLiteral<"human">;
    attestedBy: z.ZodString;
}, z.core.$strip>]>;
declare const chatMessage: z.ZodObject<{
    provenance: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
        authored: z.ZodLiteral<"human">;
    }, z.core.$strip>, z.ZodObject<{
        authored: z.ZodLiteral<"agent">;
    }, z.core.$strip>, z.ZodObject<{
        authored: z.ZodLiteral<"agent">;
        endorsedBy: z.ZodLiteral<"human">;
        attestedBy: z.ZodString;
    }, z.core.$strip>]>>;
    delivery: z.ZodOptional<z.ZodArray<z.ZodObject<{
        participantId: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            accepted: "accepted";
            delivered: "delivered";
            read: "read";
            held: "held";
            undeliverable: "undeliverable";
        }>;
        at: z.ZodString;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    id: z.ZodString;
    threadId: z.ZodString;
    authorId: z.ZodString;
    role: z.ZodEnum<{
        system: "system";
        user: "user";
        assistant: "assistant";
    }>;
    createdAt: z.ZodString;
    parts: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        state: z.ZodOptional<z.ZodEnum<{
            streaming: "streaming";
            done: "done";
        }>>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"reasoning">;
        id: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
        state: z.ZodOptional<z.ZodEnum<{
            streaming: "streaming";
            done: "done";
        }>>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"source-url">;
        sourceId: z.ZodString;
        url: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"source-document">;
        sourceId: z.ZodString;
        mediaType: z.ZodString;
        title: z.ZodString;
        filename: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"file">;
        mediaType: z.ZodString;
        filename: z.ZodOptional<z.ZodString>;
        url: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"step-start">;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodCustom<`tool-${string}`, `tool-${string}`>;
        toolCallId: z.ZodString;
        state: z.ZodEnum<{
            "input-streaming": "input-streaming";
            "input-available": "input-available";
            "approval-requested": "approval-requested";
            "approval-responded": "approval-responded";
            "output-available": "output-available";
            "output-error": "output-error";
            "output-denied": "output-denied";
        }>;
        input: z.ZodOptional<z.ZodUnknown>;
        output: z.ZodOptional<z.ZodUnknown>;
        errorText: z.ZodOptional<z.ZodString>;
        approval: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            approved: z.ZodOptional<z.ZodBoolean>;
            descriptor: z.ZodOptional<z.ZodUnknown>;
            reason: z.ZodOptional<z.ZodString>;
            signature: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        providerExecuted: z.ZodOptional<z.ZodBoolean>;
        callProviderMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        resultProviderMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodCustom<`data-${string}`, `data-${string}`>;
        id: z.ZodOptional<z.ZodString>;
        data: z.ZodUnknown;
    }, z.core.$strip>]>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    inReplyTo: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * What a transport is allowed to hand in. Strict, and without `provenance` or
 * `delivery` at all: a payload that claims either is rejected rather than
 * stripped, so an unforgeable fact cannot quietly become a forgeable claim.
 */
declare const inboundChatMessage: z.ZodObject<{
    id: z.ZodString;
    threadId: z.ZodString;
    authorId: z.ZodString;
    role: z.ZodEnum<{
        system: "system";
        user: "user";
        assistant: "assistant";
    }>;
    createdAt: z.ZodString;
    parts: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        state: z.ZodOptional<z.ZodEnum<{
            streaming: "streaming";
            done: "done";
        }>>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"reasoning">;
        id: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
        state: z.ZodOptional<z.ZodEnum<{
            streaming: "streaming";
            done: "done";
        }>>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"source-url">;
        sourceId: z.ZodString;
        url: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"source-document">;
        sourceId: z.ZodString;
        mediaType: z.ZodString;
        title: z.ZodString;
        filename: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"file">;
        mediaType: z.ZodString;
        filename: z.ZodOptional<z.ZodString>;
        url: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"step-start">;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodCustom<`tool-${string}`, `tool-${string}`>;
        toolCallId: z.ZodString;
        state: z.ZodEnum<{
            "input-streaming": "input-streaming";
            "input-available": "input-available";
            "approval-requested": "approval-requested";
            "approval-responded": "approval-responded";
            "output-available": "output-available";
            "output-error": "output-error";
            "output-denied": "output-denied";
        }>;
        input: z.ZodOptional<z.ZodUnknown>;
        output: z.ZodOptional<z.ZodUnknown>;
        errorText: z.ZodOptional<z.ZodString>;
        approval: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            approved: z.ZodOptional<z.ZodBoolean>;
            descriptor: z.ZodOptional<z.ZodUnknown>;
            reason: z.ZodOptional<z.ZodString>;
            signature: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        providerExecuted: z.ZodOptional<z.ZodBoolean>;
        callProviderMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        resultProviderMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodCustom<`data-${string}`, `data-${string}`>;
        id: z.ZodOptional<z.ZodString>;
        data: z.ZodUnknown;
    }, z.core.$strip>]>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    inReplyTo: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** The only way to mint an endorsement. Adapters call it; payloads cannot reach it. */
declare function markHumanEndorsed(message: ChatMessage, attestedBy: string): ChatMessage;

/**
 * Every transport titan speaks today — BlueBubbles without the private API,
 * the Telegram Bot API, the agent-chat bus — reports that the server took the
 * message and nothing after that.
 */
declare const TRANSPORT_DELIVERY_CEILING: DeliveryStatus;
/**
 * Clamp a claimed status to what the transport can actually observe. Without
 * this a consumer that optimistically writes `read` publishes a receipt no
 * transport ever sent.
 */
declare function capDeliveryStatus(status: DeliveryStatus, ceiling: DeliveryStatus): DeliveryStatus;

/**
 * The AI SDK `UIMessage` shape, vendored for the same reason the parts are: a
 * tier-0 package takes no runtime dependency beyond zod. Keeping the shape
 * explicit here is what makes the central claim checkable — a `ChatMessage` is
 * a `UIMessage` plus an envelope, and nothing else.
 */
interface UIMessageLike {
    id: string;
    role: ChatMessage["role"];
    metadata?: Record<string, unknown>;
    parts: ChatPart[];
}
/** Everything `UIMessage` genuinely lacks. Six fields, all additive, all strippable. */
type ChatEnvelope = Omit<ChatMessage, keyof UIMessageLike>;
/** Drop the envelope and any AI-SDK-shaped renderer can take the result unchanged. */
declare function toUIMessage(message: ChatMessage): UIMessageLike;
/**
 * The inverse. `provenance` and `delivery` are part of the envelope a caller
 * supplies, so a `UIMessage` arriving from a renderer can never assert either.
 */
declare function fromUIMessage(ui: UIMessageLike, envelope: ChatEnvelope): ChatMessage;

/**
 * `@titan-design/messaging` is tier 1 and this package is tier 0, so these
 * contracts are mirrored structurally rather than imported. Each one is
 * assignable from the real thing; the source of truth stays
 * `packages/messaging/src/{contract,inbound}.ts`.
 */
/** `InboundResult` narrowed to its accepted branch. */
interface MessagingInbound {
    status: "accepted";
    handle: string;
    /** Also the transport's dedupe key, so it becomes the message id. */
    guid: string;
    text: string;
}
/** `SendInput`: a handle and a string. No attachments exist on this seam. */
interface MessagingSendInput {
    handle: string;
    text: string;
}
/** `SendResult`. `ok: true` means accepted for sending, never delivered. */
type MessagingSendResult = {
    ok: true;
    messageGuid?: string;
} | {
    ok: false;
    error: {
        kind: string;
    };
};
interface InboundContext {
    threadId: string;
    /** An inbound webhook carries a handle, not a participant; the caller resolves it. */
    authorId: string;
    createdAt: string;
}
interface OutboundResult {
    send: MessagingSendInput;
    /** Part types the transport cannot carry. Reported, never silently swallowed. */
    dropped: string[];
}
/** A human typed this, so the adapter is the broker that may say so. */
declare function fromMessagingInbound(inbound: MessagingInbound, context: InboundContext): ChatMessage;
/**
 * Flattens to the one thing the seam accepts. A `too-long` body is the
 * composer's problem to split, so no length cap is applied here.
 */
declare function toMessagingOutbound(message: ChatMessage, handle: string): OutboundResult;
/** `SendError.kind` is the delivery reason; success caps at what the transport can see. */
declare function deliveryFromSendResult(result: MessagingSendResult, participantId: string, at: string): DeliveryState;

/**
 * `@titan-design/hitl` is tier 1, so `GateSnapshot` mirrors its `GateRecord`
 * structurally instead of importing it. The row stays in hitl: this is a
 * render-time view, and resolving still goes through `resolveGate`.
 */
interface GateSnapshot {
    id: string;
    prompt: string;
    schema?: Record<string, unknown>;
    status: "pending" | "resolved" | "cancelled" | "expired";
    payload?: unknown;
    reason?: string;
    createdAt: string;
    expiresAt?: string;
}
/** A gate is not a named tool, so every gate renders under one stable tool name. */
declare const GATE_TOOL_NAME = "gate";
declare const GATE_PART_TYPE: "tool-gate";
interface GateContext {
    threadId: string;
    /** A gate row has no author field; the opener supplies one. */
    authorId: string;
}
/**
 * MCP elicitation's `cancel` has no chat representation: a dismissed gate is
 * cancelled through `cancelGate`, not by sending a message.
 */
type GateAnswer = {
    action: "accept";
    gateId: string;
    payload: unknown;
} | {
    action: "decline";
    gateId: string;
    reason: string;
};
/** A pending gate is an approval request carrying its JSON Schema as the descriptor. */
declare function fromHitlGate(gate: GateSnapshot, context: GateContext): ChatMessage;
/**
 * Reads the verdict back out so a caller can hand it to `resolveGate` or
 * `cancelGate`. Returns undefined while the gate is still open.
 */
declare function toHitlAnswer(message: ChatMessage): GateAnswer | undefined;

export { type AddressScheme, type ChatEnvelope, type ChatMessage, type ChatPart, type ChatThread, DATA_PART_KEY_PATTERN, type DataPart, type DeliveryState, type DeliveryStatus, type FilePart, GATE_PART_TYPE, GATE_TOOL_NAME, type GateAnswer, type GateContext, type GateSnapshot, type InboundContext, type MessageRole, type MessagingInbound, type MessagingSendInput, type MessagingSendResult, type OutboundResult, type PartStreamState, type Participant, type ParticipantAddress, type ParticipantKind, type Provenance, type ProviderMetadata, type ReasoningPart, type SourceDocumentPart, type SourceUrlPart, type StepStartPart, TRANSPORT_DELIVERY_CEILING, type TextPart, type ThreadKind, type ToolApproval, type ToolPart, type ToolPartState, type UIMessageLike, addressScheme, capDeliveryStatus, chatMessage, chatPart, chatThread, dataPart, deliveryFromSendResult, deliveryState, deliveryStatus, filePart, fromHitlGate, fromMessagingInbound, fromUIMessage, inboundChatMessage, isDataPartType, isToolPartType, markHumanEndorsed, messageRole, participant, participantKind, provenance, providerMetadata, reasoningPart, sourceDocumentPart, sourceUrlPart, stepStartPart, textPart, threadKind, toHitlAnswer, toMessagingOutbound, toUIMessage, toolApproval, toolPart };
