import { describe, expect, it } from "vitest";
import type { SendInput } from "./contract.js";
import { TelegramTransport } from "./telegram.js";

const TOKEN = "123456789:AAH-fake-bot-token_for-tests";

interface Recorder {
  transport: TelegramTransport;
  bodies: Array<Record<string, unknown>>;
}

function recordingTransport(): Recorder {
  const bodies: Array<Record<string, unknown>> = [];
  const transport = new TelegramTransport({
    token: TOKEN,
    chatIdFor: () => 4242,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }));
    },
  });
  return { transport, bodies };
}

function withButtons(buttons: SendInput["buttons"]): SendInput {
  return { handle: "lifter", text: "Did you eat lunch?", buttons };
}

describe("TelegramTransport.send with buttons", () => {
  it("renders button rows as an inline keyboard with callback data", async () => {
    const { transport, bodies } = recordingTransport();

    const result = await transport.send(
      withButtons([
        [
          { label: "Ate", data: "v1|ate|lunch|2026-09-18" },
          { label: "Skipped", data: "v1|skip|lunch|2026-09-18" },
        ],
        [{ label: "Later", data: "v1|snooze|lunch|2026-09-18" }],
      ]),
    );

    expect(result).toEqual({
      ok: true,
      messageGuid: "5",
      ref: { channel: "telegram", chat: "4242", messageId: "5" },
    });
    expect(bodies[0]).toEqual({
      chat_id: 4242,
      text: "Did you eat lunch?",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Ate", callback_data: "v1|ate|lunch|2026-09-18" },
            { text: "Skipped", callback_data: "v1|skip|lunch|2026-09-18" },
          ],
          [{ text: "Later", callback_data: "v1|snooze|lunch|2026-09-18" }],
        ],
      },
    });
  });

  it("sends no reply_markup for an empty button list", async () => {
    const { transport, bodies } = recordingTransport();

    await transport.send(withButtons([]));

    expect(bodies[0]).toEqual({ chat_id: 4242, text: "Did you eat lunch?" });
  });

  it("accepts callback data of exactly 64 UTF-8 bytes", async () => {
    const { transport, bodies } = recordingTransport();

    const result = await transport.send(
      withButtons([[{ label: "Ate", data: "é".repeat(32) }]]),
    );

    expect(result.ok).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  it("refuses callback data over 64 UTF-8 bytes without calling the API", async () => {
    const { transport, bodies } = recordingTransport();
    const secretish = `v1|ate|${"é".repeat(28)}|x`;

    const result = await transport.send(
      withButtons([[{ label: "Ate", data: secretish }]]),
    );

    expect(new TextEncoder().encode(secretish).length).toBe(65);
    expect(result).toEqual({
      ok: false,
      error: { kind: "bad-buttons", message: "Button data exceeds 64 UTF-8 bytes" },
    });
    expect(JSON.stringify(result)).not.toContain(secretish);
    expect(bodies).toHaveLength(0);
  });

  it("refuses an empty label without calling the API", async () => {
    const { transport, bodies } = recordingTransport();

    const result = await transport.send(
      withButtons([[{ label: "Ate", data: "a" }], [{ label: "", data: "b" }]]),
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: "bad-buttons", message: "Every button needs a non-empty label" },
    });
    expect(bodies).toHaveLength(0);
  });
});
