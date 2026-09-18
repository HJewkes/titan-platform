import { z } from "zod";
import type { TelegramConfig } from "./telegram.js";
import { describeCause, methodUrl, readEnvelope, redactToken } from "./telegram.js";

/** The Update shapes this package reads: a text message, or a tapped inline button. */
export const telegramUpdateEvent = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      date: z.number().int(),
      text: z.string().optional(),
      from: z.object({ id: z.number().int() }).optional(),
      chat: z.object({ id: z.number().int() }),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({ id: z.number().int() }),
      message: z
        .object({
          message_id: z.number().int(),
          chat: z.object({ id: z.number().int() }),
          date: z.number().int(),
        })
        .optional(),
      data: z.string().optional(),
    })
    .optional(),
});

type TelegramUpdateEvent = z.infer<typeof telegramUpdateEvent>;

export interface TelegramTextUpdate {
  updateId: number;
  chatId: number;
  fromId: number;
  text: string;
  date: number;
}

/** A tapped inline button; `data` is the button's callback data, verbatim. */
export interface TelegramCallback {
  kind: "callback";
  updateId: number;
  chatId: number;
  fromId: number;
  callbackQueryId: string;
  messageId: number;
  data: string;
  date: number;
}

export type TelegramInbound = ({ kind: "text" } & TelegramTextUpdate) | TelegramCallback;

/** Why an update yields nothing: an unknown shape, or a known one missing a field this package needs. */
export type InboundReadResult =
  | { ok: true; inbound: TelegramInbound }
  | { ok: false; reason: "malformed" | "not-text" };

export interface PollUpdatesOptions {
  /** Passed straight to getUpdates; 0 is short polling and is for tests only. */
  timeoutSeconds: number;
  allowedChatIds: readonly (string | number)[];
  signal?: AbortSignal;
}

export function isAllowedChat(
  chatId: number,
  allowed: readonly (string | number)[],
): boolean {
  return allowed.some((entry) => String(entry) === String(chatId));
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name.endsWith("AbortError");
}

/** The token is in the URL, and a thrown fetch quotes the URL it tried. */
async function fetchUpdates(
  config: TelegramConfig,
  body: { offset?: number; timeout?: number },
  signal?: AbortSignal,
): Promise<Response> {
  const doFetch = config.fetch ?? globalThis.fetch;
  try {
    return await doFetch(methodUrl(config, "getUpdates"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw new Error(redactToken(describeCause(cause), config.token));
  }
}

async function getUpdates(
  config: TelegramConfig,
  body: { offset?: number; timeout?: number },
  signal?: AbortSignal,
): Promise<unknown[]> {
  const response = await fetchUpdates(config, body, signal);
  const envelope = await readEnvelope(response);
  if (!response.ok || !envelope.ok) {
    const description = envelope.description ?? response.statusText;
    throw new Error(
      redactToken(`getUpdates failed (${response.status}): ${description}`, config.token),
    );
  }
  return Array.isArray(envelope.result) ? envelope.result : [];
}

function toCallback(
  updateId: number,
  query: NonNullable<TelegramUpdateEvent["callback_query"]>,
): TelegramCallback | undefined {
  if (!query.message || query.data === undefined) return undefined;
  return {
    kind: "callback",
    updateId,
    chatId: query.message.chat.id,
    fromId: query.from.id,
    callbackQueryId: query.id,
    messageId: query.message.message_id,
    data: query.data,
    date: query.message.date,
  };
}

function toInbound({
  update_id: updateId,
  message,
  callback_query: query,
}: TelegramUpdateEvent): TelegramInbound | undefined {
  if (query) return toCallback(updateId, query);
  if (!message?.text || !message.from) return undefined;
  return {
    kind: "text",
    updateId,
    chatId: message.chat.id,
    fromId: message.from.id,
    text: message.text,
    date: message.date,
  };
}

/** Shared by the long poll and the webhook so both read exactly the same shapes. */
export function readInbound(raw: unknown): InboundReadResult {
  const parsed = telegramUpdateEvent.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const inbound = toInbound(parsed.data);
  return inbound ? { ok: true, inbound } : { ok: false, reason: "not-text" };
}

/** The next offset acknowledges everything in the batch, read or skipped. */
function nextOffset(batch: readonly unknown[], current: number | undefined): number | undefined {
  let highest: number | undefined;
  for (const raw of batch) {
    const parsed = telegramUpdateEvent.safeParse(raw);
    if (!parsed.success) continue;
    if (highest === undefined || parsed.data.update_id > highest) {
      highest = parsed.data.update_id;
    }
  }
  return highest === undefined ? current : highest + 1;
}

/**
 * Long-polls getUpdates forever, yielding only text messages and button taps
 * from an allowed chat. Anything else (a photo, an edit, a stranger, a shape
 * this package does not read) is acknowledged and skipped, never thrown. Abort
 * the signal to stop.
 */
export async function* pollUpdates(
  config: TelegramConfig,
  { timeoutSeconds, allowedChatIds, signal }: PollUpdatesOptions,
): AsyncGenerator<TelegramInbound> {
  let offset: number | undefined;
  while (!signal?.aborted) {
    let batch: unknown[];
    try {
      batch = await getUpdates(config, { offset, timeout: timeoutSeconds }, signal);
    } catch (cause) {
      if (isAbort(cause) || signal?.aborted) return;
      throw cause;
    }
    offset = nextOffset(batch, offset);
    for (const raw of batch) {
      const read = readInbound(raw);
      if (read.ok && isAllowedChat(read.inbound.chatId, allowedChatIds)) yield read.inbound;
    }
  }
}

/**
 * One short poll, for the human's one-time "what is my chat id" step. It passes
 * no offset, so it confirms nothing and the daemon still sees these updates.
 */
export async function readChatIds(config: TelegramConfig): Promise<number[]> {
  const batch = await getUpdates(config, { timeout: 0 });
  const ids = new Set<number>();
  for (const raw of batch) {
    const parsed = telegramUpdateEvent.safeParse(raw);
    if (parsed.success && parsed.data.message) ids.add(parsed.data.message.chat.id);
  }
  return [...ids];
}

export type AnswerCallbackResult = { ok: true } | { ok: false; reason: string };

/**
 * Stops the tapped button's loading spinner; Telegram expects this for every
 * callback. `text`, when given, shows as a brief toast. Never throws.
 */
export async function answerCallbackQuery(
  config: TelegramConfig,
  callbackQueryId: string,
  text?: string,
): Promise<AnswerCallbackResult> {
  const doFetch = config.fetch ?? globalThis.fetch;
  const body = text === undefined
    ? { callback_query_id: callbackQueryId }
    : { callback_query_id: callbackQueryId, text };
  try {
    const response = await doFetch(methodUrl(config, "answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const envelope = await readEnvelope(response);
    if (response.ok && envelope.ok) return { ok: true };
    const description = envelope.description ?? response.statusText;
    return failedAnswer(config, `answerCallbackQuery failed (${response.status}): ${description}`);
  } catch (cause) {
    return failedAnswer(config, describeCause(cause));
  }
}

function failedAnswer(config: TelegramConfig, reason: string): AnswerCallbackResult {
  return { ok: false, reason: redactToken(reason, config.token) };
}
