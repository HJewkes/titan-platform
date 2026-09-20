import type { TelegramCallback, TelegramTextUpdate } from "./telegram-updates.js";

/**
 * Raw Bot API JSON, not a parsed update: a test feeds these to the same
 * `readInbound` or `validateTelegramWebhook` a real door calls, so the parser
 * is exercised rather than bypassed.
 */
export function fakeTextUpdate(fields: Partial<TelegramTextUpdate> = {}): unknown {
  const {
    updateId = 1,
    chatId = 4242,
    fromId = 99,
    messageId = 1000,
    text = "ready",
    date = 1757808000,
    threadId,
    replyToMessageId,
  } = fields;
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date,
      text,
      from: { id: fromId, is_bot: false, first_name: "Lifter" },
      chat: { id: chatId, type: "private" },
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      ...(replyToMessageId === undefined ? {} : { reply_to_message: { message_id: replyToMessageId } }),
    },
  };
}

export function fakeCallbackUpdate(fields: Partial<TelegramCallback> = {}): unknown {
  const {
    updateId = 2,
    chatId = 4242,
    fromId = 99,
    callbackQueryId = "cbq-2",
    messageId = 1001,
    data = "v1|ate|lunch|2026-09-18",
    date = 1757808000,
    threadId,
    messageText,
    buttons,
  } = fields;
  return {
    update_id: updateId,
    callback_query: {
      id: callbackQueryId,
      from: { id: fromId, is_bot: false, first_name: "Lifter" },
      chat_instance: "-123",
      data,
      message: {
        message_id: messageId,
        date,
        chat: { id: chatId, type: "private" },
        ...(threadId === undefined ? {} : { message_thread_id: threadId }),
        ...(messageText === undefined ? {} : { text: messageText }),
        ...(buttons === undefined
          ? {}
          : {
              reply_markup: {
                inline_keyboard: buttons.map((row) =>
                  row.map((button) => ({ text: button.label, callback_data: button.data })),
                ),
              },
            }),
      },
    },
  };
}
