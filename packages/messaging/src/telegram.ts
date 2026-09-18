import type {
  ButtonRow,
  MessageTransport,
  SendError,
  SendInput,
  SendResult,
} from "./contract.js";
import { sendFailed } from "./contract.js";

export interface TelegramConfig {
  /** Bot token from BotFather. It sits in the URL path, so it is redacted everywhere. */
  token: string;
  /** A bot cannot message a chat it has never seen, so the chat id comes from outside. */
  chatIdFor: (
    handle: string,
  ) => string | number | undefined | Promise<string | number | undefined>;
  fetch?: typeof fetch;
  /** Override for a local Bot API server. Defaults to the cloud one. */
  baseUrl?: string;
}

export const TELEGRAM_BASE_URL = "https://api.telegram.org";

/** `sendMessage` documents `text` as 1-4096 characters after entities parsing. */
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;

/** `callback_data` is documented as 1-64 bytes, and Telegram counts UTF-8 bytes. */
export const TELEGRAM_MAX_CALLBACK_DATA_BYTES = 64;

/** Every string that leaves this module passes through here. */
export function redactToken(value: string, token: string): string {
  if (!token) return value;
  const encoded = encodeURIComponent(token);
  const once = value.split(token).join("***");
  return encoded === token ? once : once.split(encoded).join("***");
}

export function methodUrl(config: TelegramConfig, method: string): string {
  const origin = (config.baseUrl ?? TELEGRAM_BASE_URL).replace(/\/+$/, "");
  return `${origin}/bot${config.token}/${method}`;
}

export function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

/** The Bot API envelope: `{ ok, result }`, or `{ ok: false, description }`. */
export interface TelegramEnvelope {
  ok: boolean;
  result?: unknown;
  description?: string;
}

export async function readEnvelope(
  response: Response,
): Promise<TelegramEnvelope> {
  try {
    const body = (await response.json()) as {
      ok?: unknown;
      result?: unknown;
      description?: unknown;
    };
    return {
      ok: body.ok === true,
      result: body.result,
      description:
        typeof body.description === "string" ? body.description : undefined,
    };
  } catch {
    return { ok: false };
  }
}

function errorForStatus(
  status: number,
  message: string,
  handle: string,
): SendError {
  if (status === 401) return { kind: "unauthorized", message };
  if (status === 400 && /chat not found/i.test(message)) {
    return { kind: "no-chat", handle, message };
  }
  if (status >= 400 && status < 500) return { kind: "rejected", status, message };
  return { kind: "unknown", message: `HTTP ${status}: ${message}` };
}

/** The message never quotes a data value: consumers may put ids in it. */
function buttonsError(rows: readonly ButtonRow[]): SendError | undefined {
  const buttons = rows.flat();
  if (buttons.some((button) => button.label === "")) {
    return { kind: "bad-buttons", message: "Every button needs a non-empty label" };
  }
  const encoder = new TextEncoder();
  const tooLong = buttons.some(
    (button) => encoder.encode(button.data).length > TELEGRAM_MAX_CALLBACK_DATA_BYTES,
  );
  if (!tooLong) return undefined;
  return {
    kind: "bad-buttons",
    message: `Button data exceeds ${TELEGRAM_MAX_CALLBACK_DATA_BYTES} UTF-8 bytes`,
  };
}

function sendError({ text, buttons }: SendInput): SendError | undefined {
  if (text.length > TELEGRAM_MAX_TEXT_LENGTH) {
    return {
      kind: "too-long",
      limit: TELEGRAM_MAX_TEXT_LENGTH,
      length: text.length,
      message: `Text is ${text.length} characters; the limit is ${TELEGRAM_MAX_TEXT_LENGTH}`,
    };
  }
  return buttons ? buttonsError(buttons) : undefined;
}

function messageBody(
  chatId: string | number,
  { text, buttons }: SendInput,
): Record<string, unknown> {
  if (!buttons || buttons.length === 0) return { chat_id: chatId, text };
  const inlineKeyboard = buttons.map((row) =>
    row.map((button) => ({ text: button.label, callback_data: button.data })),
  );
  return { chat_id: chatId, text, reply_markup: { inline_keyboard: inlineKeyboard } };
}

function readMessageId(result: unknown): string | undefined {
  const id = (result as { message_id?: unknown } | null)?.message_id;
  return typeof id === "number" ? String(id) : undefined;
}

/**
 * Sends over the Telegram Bot API with `fetch` only, so the same code runs in a
 * Worker, a daemon, and a test. No `parse_mode`: coach copy is sent verbatim.
 */
export class TelegramTransport implements MessageTransport {
  private readonly doFetch: typeof fetch;

  constructor(private readonly config: TelegramConfig) {
    this.doFetch = config.fetch ?? globalThis.fetch;
  }

  async send(input: SendInput): Promise<SendResult> {
    const { handle } = input;
    const invalid = sendError(input);
    if (invalid) return sendFailed(invalid);

    const chatId = await this.resolveChatId(handle);
    if (chatId.kind !== "ok") return sendFailed(chatId.error);

    let response: Response;
    try {
      response = await this.postMessage(messageBody(chatId.value, input));
    } catch (cause) {
      return sendFailed({
        kind: "unreachable",
        message: this.redact(describeCause(cause)),
      });
    }

    const envelope = await readEnvelope(response);
    const message = this.redact(envelope.description ?? response.statusText);
    if (!response.ok || !envelope.ok) {
      return sendFailed(errorForStatus(response.status, message, handle));
    }
    return { ok: true, messageGuid: readMessageId(envelope.result) };
  }

  private async postMessage(body: Record<string, unknown>): Promise<Response> {
    return await this.doFetch(methodUrl(this.config, "sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async resolveChatId(handle: string): Promise<
    { kind: "ok"; value: string | number } | { kind: "err"; error: SendError }
  > {
    let chatId: string | number | undefined;
    try {
      chatId = await this.config.chatIdFor(handle);
    } catch (cause) {
      return {
        kind: "err",
        error: { kind: "unknown", message: this.redact(describeCause(cause)) },
      };
    }
    if (chatId !== undefined && chatId !== "") {
      return { kind: "ok", value: chatId };
    }
    return {
      kind: "err",
      error: {
        kind: "no-chat",
        handle,
        message: "No chat id for handle; the user must message the bot first",
      },
    };
  }

  private redact(value: string): string {
    return redactToken(value, this.config.token);
  }
}

export function createTelegramTransport(
  config: TelegramConfig,
): MessageTransport {
  return new TelegramTransport(config);
}
