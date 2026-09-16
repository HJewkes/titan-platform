import { capDeliveryStatus, TRANSPORT_DELIVERY_CEILING } from "../delivery.js";
import type { ChatMessage, DeliveryState } from "../envelope.js";

/**
 * `@titan-design/messaging` is tier 1 and this package is tier 0, so these
 * contracts are mirrored structurally rather than imported. Each one is
 * assignable from the real thing; the source of truth stays
 * `packages/messaging/src/{contract,inbound}.ts`.
 */

/** `InboundResult` narrowed to its accepted branch. */
export interface MessagingInbound {
  status: "accepted";
  handle: string;
  /** Also the transport's dedupe key, so it becomes the message id. */
  guid: string;
  text: string;
}

/** `SendInput`: a handle and a string. No attachments exist on this seam. */
export interface MessagingSendInput {
  handle: string;
  text: string;
}

/** `SendResult`. `ok: true` means accepted for sending, never delivered. */
export type MessagingSendResult = { ok: true; messageGuid?: string } | { ok: false; error: { kind: string } };

export interface InboundContext {
  threadId: string;
  /** An inbound webhook carries a handle, not a participant; the caller resolves it. */
  authorId: string;
  createdAt: string;
}

export interface OutboundResult {
  send: MessagingSendInput;
  /** Part types the transport cannot carry. Reported, never silently swallowed. */
  dropped: string[];
}

/** A human typed this, so the adapter is the broker that may say so. */
export function fromMessagingInbound(inbound: MessagingInbound, context: InboundContext): ChatMessage {
  return {
    id: inbound.guid,
    threadId: context.threadId,
    authorId: context.authorId,
    role: "user",
    createdAt: context.createdAt,
    parts: [{ type: "text", text: inbound.text }],
    provenance: { authored: "human" },
  };
}

/**
 * Flattens to the one thing the seam accepts. A `too-long` body is the
 * composer's problem to split, so no length cap is applied here.
 */
export function toMessagingOutbound(message: ChatMessage, handle: string): OutboundResult {
  const text: string[] = [];
  const dropped: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") text.push(part.text);
    else dropped.push(part.type);
  }
  return { send: { handle, text: text.join("\n\n") }, dropped };
}

/** `SendError.kind` is the delivery reason; success caps at what the transport can see. */
export function deliveryFromSendResult(
  result: MessagingSendResult,
  participantId: string,
  at: string,
): DeliveryState {
  if (!result.ok) {
    return { participantId, status: "undeliverable", at, reason: result.error.kind };
  }
  return {
    participantId,
    status: capDeliveryStatus("delivered", TRANSPORT_DELIVERY_CEILING),
    at,
  };
}
