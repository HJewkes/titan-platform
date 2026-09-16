import { z } from "zod";
import { chatPart, type ChatPart } from "./parts.js";

/**
 * The envelope is everything `UIMessage` genuinely lacks: a thread, a
 * participant beyond the three roles, per-recipient delivery, and broker-set
 * provenance. Strip those four fields and a `ChatMessage` is a plain
 * `UIMessage`, which is the whole point of adding no part types.
 */

/** The AI SDK's roles, verbatim. `tool` is not one: tool results ride `tool-*` parts. */
export type MessageRole = "system" | "user" | "assistant";

/** `kind` picks the renderer's affordances, never its parsing. */
export type ThreadKind = "coach" | "agent-run" | "bus" | "device" | "harness";

export type ParticipantKind = "human" | "agent" | "device" | "service";

export type AddressScheme = "telegram" | "imessage" | "agent-chat" | "mcp";

export interface ParticipantAddress {
  scheme: AddressScheme;
  value: string;
}

/** Identity lives in `id`. A role is a rendering hint, never an identity. */
export interface Participant {
  id: string;
  role: MessageRole;
  displayName: string;
  kind: ParticipantKind;
  address?: ParticipantAddress;
}

export interface ChatThread {
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
export type DeliveryStatus = "pending" | "accepted" | "delivered" | "read" | "held" | "undeliverable";

export interface DeliveryState {
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
export type Provenance =
  | { authored: "human" }
  | { authored: "agent" }
  | { authored: "agent"; endorsedBy: "human"; attestedBy: string };

export interface ChatMessage {
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

export const messageRole = z.enum(["system", "user", "assistant"]);
export const threadKind = z.enum(["coach", "agent-run", "bus", "device", "harness"]);
export const participantKind = z.enum(["human", "agent", "device", "service"]);
export const addressScheme = z.enum(["telegram", "imessage", "agent-chat", "mcp"]);

export const participant = z.object({
  id: z.string().min(1),
  role: messageRole,
  displayName: z.string(),
  kind: participantKind,
  address: z.object({ scheme: addressScheme, value: z.string().min(1) }).optional(),
});

export const chatThread = z.object({
  id: z.string().min(1),
  kind: threadKind,
  title: z.string().optional(),
  participants: z.array(participant),
  createdAt: z.string().min(1),
});

export const deliveryStatus = z.enum([
  "pending",
  "accepted",
  "delivered",
  "read",
  "held",
  "undeliverable",
]);

export const deliveryState = z.object({
  participantId: z.string().min(1),
  status: deliveryStatus,
  at: z.string().min(1),
  reason: z.string().optional(),
});

export const provenance = z.union([
  z.object({ authored: z.literal("human") }),
  z.object({ authored: z.literal("agent") }),
  z.object({
    authored: z.literal("agent"),
    endorsedBy: z.literal("human"),
    attestedBy: z.string().min(1),
  }),
]);

const messageBody = {
  id: z.string().min(1),
  threadId: z.string().min(1),
  authorId: z.string().min(1),
  role: messageRole,
  createdAt: z.string().min(1),
  parts: z.array(chatPart),
  metadata: z.record(z.string(), z.unknown()).optional(),
  inReplyTo: z.string().optional(),
};

export const chatMessage = z.object({
  ...messageBody,
  provenance: provenance.optional(),
  delivery: z.array(deliveryState).optional(),
});

/**
 * What a transport is allowed to hand in. Strict, and without `provenance` or
 * `delivery` at all: a payload that claims either is rejected rather than
 * stripped, so an unforgeable fact cannot quietly become a forgeable claim.
 */
export const inboundChatMessage = z.strictObject(messageBody);

/** The only way to mint an endorsement. Adapters call it; payloads cannot reach it. */
export function markHumanEndorsed(message: ChatMessage, attestedBy: string): ChatMessage {
  return { ...message, provenance: { authored: "agent", endorsedBy: "human", attestedBy } };
}
