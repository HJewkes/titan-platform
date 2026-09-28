import type {
  Button,
  ButtonRow,
  ChannelCapabilities,
  EditInput,
  InteractionResult,
  InteractiveTransport,
  MessageRef,
  SendError,
  SendInput,
  SendResult,
} from "./contract.js";
import { emptyEditError, sendFailed } from "./contract.js";
import type { TelegramConfig } from "./telegram-api.js";
import {
  callBotApi,
  describeCause,
  redactToken,
  TELEGRAM_MAX_CALLBACK_DATA_BYTES,
  TELEGRAM_MAX_TEXT_LENGTH,
} from "./telegram-api.js";

/** The Bot API plumbing lives next door; re-exported so no consumer's import path moves. */
export * from "./telegram-api.js";

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

/**
 * `style` is Bot API 9.4 and `disabled` is 10.3; both shapes are UNVERIFIED
 * against a live bot, so TP-290 keeps them behind `buttonStates` until spike S5.
 */
function inlineButton(button: Button, buttonStates: boolean): Record<string, unknown> {
  const base = { text: button.label, callback_data: button.data };
  if (!buttonStates) return base;
  return {
    ...base,
    ...(button.style ? { style: button.style } : {}),
    ...(button.state === "disabled" ? { disabled: {} } : {}),
  };
}

function inlineKeyboard(rows: readonly ButtonRow[], buttonStates: boolean): unknown {
  return {
    inline_keyboard: rows.map((row) => row.map((button) => inlineButton(button, buttonStates))),
  };
}

function messageBody(
  chatId: string | number,
  { text, buttons }: SendInput,
  buttonStates: boolean,
): Record<string, unknown> {
  if (!buttons || buttons.length === 0) return { chat_id: chatId, text };
  return { chat_id: chatId, text, reply_markup: inlineKeyboard(buttons, buttonStates) };
}

/** Telegram answers 400 for both, and only the text tells a quiet no-op from a lost message. */
function editOutcome(error: SendError): InteractionResult {
  if (error.kind === "rejected" && /message is not modified/i.test(error.message)) {
    return { ok: true, changed: false };
  }
  if (error.kind === "rejected" && /message to edit not found/i.test(error.message)) {
    return { ok: false, error: { kind: "message-gone", message: error.message } };
  }
  return { ok: false, error };
}

function editBody(
  { ref, text, buttons }: EditInput,
  buttonStates: boolean,
): { method: string; body: Record<string, unknown> } {
  const target = {
    chat_id: ref.chat,
    message_id: Number(ref.messageId),
    ...(buttons === undefined
      ? {}
      : { reply_markup: buttons === "remove" ? { inline_keyboard: [] } : inlineKeyboard(buttons, buttonStates) }),
  };
  return text === undefined
    ? { method: "editMessageReplyMarkup", body: target }
    : { method: "editMessageText", body: { ...target, text } };
}

function readMessageId(result: unknown): string | undefined {
  const id = (result as { message_id?: unknown } | null)?.message_id;
  return typeof id === "number" ? String(id) : undefined;
}

/**
 * Sends over the Telegram Bot API with `fetch` only, so the same code runs in a
 * Worker, a daemon, and a test. No `parse_mode`: coach copy is sent verbatim.
 */
export class TelegramTransport implements InteractiveTransport {
  readonly capabilities: ChannelCapabilities;

  constructor(private readonly config: TelegramConfig) {
    this.capabilities = telegramCapabilities(config);
  }

  async send(input: SendInput): Promise<SendResult> {
    const { handle } = input;
    const invalid = sendError(input);
    if (invalid) return sendFailed(invalid);

    const chatId = await this.resolveChatId(handle);
    if (chatId.kind !== "ok") return sendFailed(chatId.error);

    const call = await callBotApi(
      this.config,
      "sendMessage",
      messageBody(chatId.value, input, this.capabilities.buttonStates),
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

  /** A second call replaces the mark, so a product can swap "seen" for "done". */
  async react({ to, emoji }: { to: MessageRef; emoji: string | null }): Promise<InteractionResult> {
    return await this.interact("setMessageReaction", {
      chat_id: to.chat,
      message_id: Number(to.messageId),
      reaction: emoji === null ? [] : [{ type: "emoji", emoji }],
    });
  }

  /** Telegram shows it for five seconds or until the bot's next message; keeping it alive is the caller's job. */
  async chatAction({
    handle,
    action,
    threadId,
  }: {
    handle: string;
    action: "typing";
    threadId?: string;
  }): Promise<InteractionResult> {
    const chatId = await this.resolveChatId(handle);
    if (chatId.kind !== "ok") return { ok: false, error: chatId.error };
    return await this.interact("sendChatAction", {
      chat_id: chatId.value,
      action,
      ...(threadId === undefined ? {} : { message_thread_id: Number(threadId) }),
    });
  }

  async edit(input: EditInput): Promise<InteractionResult> {
    const invalid = emptyEditError(input);
    if (invalid) return { ok: false, error: invalid };

    const { method, body } = editBody(input, this.capabilities.buttonStates);
    const call = await callBotApi(this.config, method, body);
    return call.ok ? { ok: true, changed: true } : editOutcome(call.error);
  }

  async answerAction({
    actionId,
    toast,
  }: {
    actionId: string;
    toast?: string;
  }): Promise<InteractionResult> {
    return await this.interact("answerCallbackQuery", {
      callback_query_id: actionId,
      ...(toast === undefined ? {} : { text: toast }),
    });
  }

  private async interact(
    method: string,
    body: Record<string, unknown>,
  ): Promise<InteractionResult> {
    const call = await callBotApi(this.config, method, body);
    return call.ok ? { ok: true, changed: true } : { ok: false, error: call.error };
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

/**
 * A flag is true only where this adapter implements the thing today, so
 * `drafts` waits for TP-292 and `threads` for TP-295 rather than describing
 * what the Bot API could do.
 */
function telegramCapabilities(config: TelegramConfig): ChannelCapabilities {
  return {
    channel: "telegram",
    maxTextLength: TELEGRAM_MAX_TEXT_LENGTH,
    canInitiate: false,
    deliveryCeiling: "accepted",
    buttons: true,
    buttonStates: config.buttonStates === true,
    edits: true,
    reactions: true,
    chatActions: true,
    drafts: false,
    draftStreaming: false,
    threads: false,
  };
}

export function createTelegramTransport(
  config: TelegramConfig,
): InteractiveTransport {
  return new TelegramTransport(config);
}
