import type { SeenStore } from "./inbound.js";
import { constantTimeEqual } from "./inbound.js";
import type { TelegramInbound } from "./telegram-updates.js";
import { isAllowedChat, readInbound } from "./telegram-updates.js";

export type TelegramRejection =
  | "bad-secret"
  | "sender-not-allowed"
  | "duplicate"
  | "too-long"
  | "malformed"
  | "not-text";

export type TelegramInboundResult =
  | ({ status: "accepted" } & TelegramInbound)
  | { status: "rejected"; reason: TelegramRejection };

export interface ValidateTelegramWebhookInput {
  /** The `X-Telegram-Bot-Api-Secret-Token` header Telegram echoes from setWebhook. */
  headerSecret: string;
  expectedSecret: string;
  allowedChatIds: readonly (string | number)[];
  body: unknown;
  /** Applies to text messages; callback data is already capped at 64 bytes by Telegram. */
  maxTextLength: number;
  seen: SeenStore;
}

function rejected(reason: TelegramRejection): TelegramInboundResult {
  return { status: "rejected", reason };
}

/**
 * Pure: every effect is in the injected `seen` store. Accepts a text message
 * or a button tap, read exactly as `pollUpdates` reads them. Telegram signs nothing,
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

  const parsed = readInbound(body);
  if (!parsed.ok) return rejected(parsed.reason);

  const update = parsed.inbound;
  if (!isAllowedChat(update.chatId, allowedChatIds)) {
    return rejected("sender-not-allowed");
  }
  if (update.kind === "text" && update.text.length > maxTextLength) {
    return rejected("too-long");
  }
  if (await seen.has(String(update.updateId))) return rejected("duplicate");

  await seen.add(String(update.updateId));
  return { status: "accepted", ...update };
}
