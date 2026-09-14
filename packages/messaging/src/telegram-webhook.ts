import type { SeenStore } from "./inbound.js";
import { constantTimeEqual } from "./inbound.js";
import { isAllowedChat, telegramUpdateEvent } from "./telegram-updates.js";

export type TelegramRejection =
  | "bad-secret"
  | "sender-not-allowed"
  | "duplicate"
  | "too-long"
  | "malformed"
  | "not-text";

export type TelegramInboundResult =
  | {
      status: "accepted";
      updateId: number;
      chatId: number;
      fromId: number;
      text: string;
      date: number;
    }
  | { status: "rejected"; reason: TelegramRejection };

export interface ValidateTelegramWebhookInput {
  /** The `X-Telegram-Bot-Api-Secret-Token` header Telegram echoes from setWebhook. */
  headerSecret: string;
  expectedSecret: string;
  allowedChatIds: readonly (string | number)[];
  body: unknown;
  maxTextLength: number;
  seen: SeenStore;
}

function rejected(reason: TelegramRejection): TelegramInboundResult {
  return { status: "rejected", reason };
}

/**
 * Pure: every effect is in the injected `seen` store. Telegram signs nothing,
 * so the echoed secret header, the chat allowlist and the update_id dedupe are
 * the whole boundary.
 */
export async function validateTelegramWebhook({
  headerSecret,
  expectedSecret,
  allowedChatIds,
  body,
  maxTextLength,
  seen,
}: ValidateTelegramWebhookInput): Promise<TelegramInboundResult> {
  if (!expectedSecret || !constantTimeEqual(headerSecret, expectedSecret)) {
    return rejected("bad-secret");
  }

  const parsed = telegramUpdateEvent.safeParse(body);
  if (!parsed.success) return rejected("malformed");

  const { update_id: updateId, message } = parsed.data;
  if (!message?.text || !message.from) return rejected("not-text");
  if (!isAllowedChat(message.chat.id, allowedChatIds)) {
    return rejected("sender-not-allowed");
  }
  if (message.text.length > maxTextLength) return rejected("too-long");
  if (await seen.has(String(updateId))) return rejected("duplicate");

  await seen.add(String(updateId));
  return {
    status: "accepted",
    updateId,
    chatId: message.chat.id,
    fromId: message.from.id,
    text: message.text,
    date: message.date,
  };
}
