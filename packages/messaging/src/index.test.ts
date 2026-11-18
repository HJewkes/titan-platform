import { describe, expect, it } from "vitest";
import { TELEGRAM_MAX_PHOTO_BYTES, TELEGRAM_MAX_VOICE_BYTES } from "./index.js";

describe("messaging entry", () => {
  it("exports the Telegram photo and voice size limits with Bot API values", () => {
    expect(TELEGRAM_MAX_PHOTO_BYTES).toBe(10 * 1024 * 1024);
    expect(TELEGRAM_MAX_VOICE_BYTES).toBe(50 * 1024 * 1024);
  });
});
