import { z } from "zod";
import type { TelegramConfig } from "./telegram.js";
import { describeCause, methodUrl, readEnvelope, redactToken } from "./telegram.js";

/** The one Update shape this package reads: a text message in a chat. */
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
});

export interface TelegramTextUpdate {
  updateId: number;
  chatId: number;
  fromId: number;
  text: string;
  date: number;
}

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

function toTextUpdate(raw: unknown): TelegramTextUpdate | undefined {
  const parsed = telegramUpdateEvent.safeParse(raw);
  if (!parsed.success) return undefined;
  const { update_id: updateId, message } = parsed.data;
  if (!message?.text || !message.from) return undefined;
  return {
    updateId,
    chatId: message.chat.id,
    fromId: message.from.id,
    text: message.text,
    date: message.date,
  };
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
 * Long-polls getUpdates forever, yielding only text messages from an allowed
 * chat. Anything else (a photo, an edit, a stranger, a shape this package does
 * not read) is acknowledged and skipped, never thrown. Abort the signal to stop.
 */
export async function* pollUpdates(
  config: TelegramConfig,
  { timeoutSeconds, allowedChatIds, signal }: PollUpdatesOptions,
): AsyncGenerator<TelegramTextUpdate> {
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
      const update = toTextUpdate(raw);
      if (update && isAllowedChat(update.chatId, allowedChatIds)) yield update;
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
