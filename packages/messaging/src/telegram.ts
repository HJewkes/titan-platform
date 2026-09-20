import type {
  ButtonRow,
  MessageTransport,
  SendError,
  SendInput,
  SendResult,
} from "./contract.js";
import { sendFailed } from "./contract.js";
import { attemptFetch, unreadableSuccess } from "./send-failure.js";

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
  errorCode?: number;
  parameters?: { retryAfterSeconds?: number; migrateToChatId?: number };
}

export async function readEnvelope(
  response: Response,
): Promise<TelegramEnvelope> {
  return (await tryReadEnvelope(response)) ?? { ok: false };
}

function readParameters(raw: unknown): TelegramEnvelope["parameters"] {
  const { retry_after: retry, migrate_to_chat_id: migrate } =
    (raw as { retry_after?: unknown; migrate_to_chat_id?: unknown } | null) ?? {};
  const parameters = {
    ...(typeof retry === "number" ? { retryAfterSeconds: retry } : {}),
    ...(typeof migrate === "number" ? { migrateToChatId: migrate } : {}),
  };
  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

/** Undefined when the body is not JSON or the connection drops while it is read. */
async function tryReadEnvelope(
  response: Response,
): Promise<TelegramEnvelope | undefined> {
  try {
    const body = (await response.json()) as {
      ok?: unknown;
      result?: unknown;
      description?: unknown;
      error_code?: unknown;
      parameters?: unknown;
    };
    const parameters = readParameters(body.parameters);
    return {
      ok: body.ok === true,
      result: body.result,
      description:
        typeof body.description === "string" ? body.description : undefined,
      ...(typeof body.error_code === "number" ? { errorCode: body.error_code } : {}),
      ...(parameters ? { parameters } : {}),
    };
  } catch {
    return undefined;
  }
}

/** `parameters.retry_after` is authoritative; the description is the fallback relay parsed by hand. */
function retryAfterSeconds(
  message: string,
  envelope: TelegramEnvelope | undefined,
): number | undefined {
  const named = envelope?.parameters?.retryAfterSeconds;
  if (named !== undefined) return named;
  const match = /retry after (\d+)/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

function errorForStatus(
  status: number,
  message: string,
  handle: string,
  envelope?: TelegramEnvelope,
): SendError {
  if (status === 401) return { kind: "unauthorized", message };
  if (status === 429) {
    const seconds = retryAfterSeconds(message, envelope);
    return { kind: "rate-limited", ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }), message };
  }
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

export type BotApiCall =
  | { ok: true; result: unknown }
  | { ok: false; error: SendError };

/** Parsing the URL here, not inside fetch, is what lets a malformed base URL count as never sent. */
function methodRequest(
  config: TelegramConfig,
  method: string,
  body: Record<string, unknown>,
): Parameters<typeof fetch> {
  return [
    new URL(methodUrl(config, method)),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  ];
}

/**
 * The one path from this package to the Bot API: attempt, envelope, typed error,
 * redaction. Every method goes through it, so the token cannot reach a string by
 * a new route. `handle` only shapes the `no-chat` case.
 */
export async function callBotApi(
  config: TelegramConfig,
  method: string,
  body: Record<string, unknown>,
  handle = "",
): Promise<BotApiCall> {
  const redact = (value: string): string => redactToken(value, config.token);
  const attempt = await attemptFetch(config.fetch ?? globalThis.fetch, () =>
    methodRequest(config, method, body),
  );
  if (!attempt.sent) {
    return { ok: false, error: { kind: attempt.kind, message: redact(describeCause(attempt.cause)) } };
  }
  const { response } = attempt;
  const envelope = await tryReadEnvelope(response);
  if (response.ok && envelope === undefined) {
    return { ok: false, error: unreadableSuccess(response.status) };
  }
  const message = redact(envelope?.description ?? response.statusText);
  if (!response.ok || !envelope?.ok) {
    return { ok: false, error: errorForStatus(response.status, message, handle, envelope) };
  }
  return { ok: true, result: envelope.result };
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
  constructor(private readonly config: TelegramConfig) {}

  async send(input: SendInput): Promise<SendResult> {
    const { handle } = input;
    const invalid = sendError(input);
    if (invalid) return sendFailed(invalid);

    const chatId = await this.resolveChatId(handle);
    if (chatId.kind !== "ok") return sendFailed(chatId.error);

    const call = await callBotApi(
      this.config,
      "sendMessage",
      messageBody(chatId.value, input),
      handle,
    );
    if (!call.ok) return sendFailed(call.error);
    const messageId = readMessageId(call.result);
    if (messageId === undefined) return { ok: true };
    return {
      ok: true,
      messageGuid: messageId,
      ref: { channel: "telegram", chat: String(chatId.value), messageId },
    };
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
