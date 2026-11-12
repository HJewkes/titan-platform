import type { MediaFile, SendError } from "./contract.js";

/** `sendPhoto` documents `caption` as 0-1024 characters after entities parsing. */
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

export function captionError(caption: string | undefined): SendError | undefined {
  if (caption === undefined || caption.length <= TELEGRAM_MAX_CAPTION_LENGTH) return undefined;
  return {
    kind: "too-long",
    limit: TELEGRAM_MAX_CAPTION_LENGTH,
    length: caption.length,
    message: `Caption is ${caption.length} characters; the limit is ${TELEGRAM_MAX_CAPTION_LENGTH}`,
  };
}

/**
 * The Bot API caps an uploaded photo at 10 MB and any other uploaded file, a voice
 * note included, at 50 MB (https://core.telegram.org/bots/api#sending-files). Past
 * that Telegram rejects the request, so refusing first spares the upload. Read as
 * MiB, so a file Telegram would take is never refused here.
 */
export const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_MAX_VOICE_BYTES = 50 * 1024 * 1024;

/** Reuses `too-long`, which already carries a limit and a length, rather than widening the error union. */
export function mediaSizeError(
  file: MediaFile,
  limit: number,
  what: string,
): SendError | undefined {
  const length = file.bytes.byteLength;
  if (length <= limit) return undefined;
  return {
    kind: "too-long",
    limit,
    length,
    message: `${what} is ${length} bytes; the upload limit is ${limit}`,
  };
}

/** Telegram plays a voice note only as OGG with Opus, so that is the default label. */
const VOICE_DEFAULTS = { fileName: "voice.ogg", mimeType: "audio/ogg" };
const PHOTO_DEFAULTS = { fileName: "photo.jpg", mimeType: "image/jpeg" };

/** The copy detaches the upload from a buffer the caller may reuse or share. */
function filePart(file: MediaFile, defaults: typeof VOICE_DEFAULTS): [Blob, string] {
  const blob = new Blob([file.bytes.slice()], { type: file.mimeType ?? defaults.mimeType });
  return [blob, file.fileName ?? defaults.fileName];
}

function chatForm(chatId: string | number): FormData {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  return form;
}

export function voiceForm(chatId: string | number, audio: MediaFile): FormData {
  const form = chatForm(chatId);
  form.append("voice", ...filePart(audio, VOICE_DEFAULTS));
  return form;
}

export function photoForm(
  chatId: string | number,
  image: MediaFile,
  caption: string | undefined,
): FormData {
  const form = chatForm(chatId);
  form.append("photo", ...filePart(image, PHOTO_DEFAULTS));
  if (caption !== undefined) form.append("caption", caption);
  return form;
}
