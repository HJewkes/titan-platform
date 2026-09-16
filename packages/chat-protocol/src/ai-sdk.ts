import type { ChatMessage } from "./envelope.js";
import type { ChatPart } from "./parts.js";

/**
 * The AI SDK `UIMessage` shape, vendored for the same reason the parts are: a
 * tier-0 package takes no runtime dependency beyond zod. Keeping the shape
 * explicit here is what makes the central claim checkable — a `ChatMessage` is
 * a `UIMessage` plus an envelope, and nothing else.
 */
export interface UIMessageLike {
  id: string;
  role: ChatMessage["role"];
  metadata?: Record<string, unknown>;
  parts: ChatPart[];
}

/** Everything `UIMessage` genuinely lacks. Six fields, all additive, all strippable. */
export type ChatEnvelope = Omit<ChatMessage, keyof UIMessageLike>;

/** Drop the envelope and any AI-SDK-shaped renderer can take the result unchanged. */
export function toUIMessage(message: ChatMessage): UIMessageLike {
  const ui: UIMessageLike = { id: message.id, role: message.role, parts: message.parts };
  if (message.metadata) ui.metadata = message.metadata;
  return ui;
}

/**
 * The inverse. `provenance` and `delivery` are part of the envelope a caller
 * supplies, so a `UIMessage` arriving from a renderer can never assert either.
 */
export function fromUIMessage(ui: UIMessageLike, envelope: ChatEnvelope): ChatMessage {
  const message: ChatMessage = { ...envelope, id: ui.id, role: ui.role, parts: ui.parts };
  if (ui.metadata) message.metadata = ui.metadata;
  return message;
}
