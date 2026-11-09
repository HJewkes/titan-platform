import { describe, expect, it } from "vitest";
import { BlueBubblesTransport } from "./bluebubbles.js";
import type { MediaFile } from "./contract.js";
import { MockTransport } from "./mock.js";
import { TELEGRAM_MAX_CAPTION_LENGTH, TelegramTransport } from "./telegram.js";

const TOKEN = "123456789:AAH-fake-bot-token_for-tests";
const AUDIO: MediaFile = { bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]) };
const IMAGE: MediaFile = { bytes: new Uint8Array([0xff, 0xd8, 0xff]), fileName: "plate.jpg" };

interface Upload {
  method: string;
  form: FormData;
  contentType: string | null;
}

function telegram(respond: () => Response = () => accepted(77)) {
  const uploads: Upload[] = [];
  const transport = new TelegramTransport({
    token: TOKEN,
    chatIdFor: () => 4242,
    fetch: async (url, init) => {
      if (!(init?.body instanceof FormData)) throw new Error("expected a multipart body");
      uploads.push({
        method: String(url).split("/").pop() ?? "",
        form: init.body,
        contentType: new Headers(init.headers).get("content-type"),
      });
      return respond();
    },
  });
  return { transport, uploads };
}

function accepted(messageId: number): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }));
}

async function bytesOf(part: FormDataEntryValue | null): Promise<number[]> {
  if (!(part instanceof Blob)) throw new Error("expected a file part");
  return [...new Uint8Array(await part.arrayBuffer())];
}

describe("Telegram media sends", () => {
  it("a voice send posts sendVoice as multipart with the chat id", async () => {
    const { transport, uploads } = telegram();

    const result = await transport.sendVoice({ handle: "lifter", audio: AUDIO });

    expect(result).toEqual({ ok: true, ref: { channel: "telegram", chat: "4242", messageId: "77" } });
    expect(uploads).toHaveLength(1);
    const [upload] = uploads;
    expect(upload?.method).toBe("sendVoice");
    expect(upload?.contentType).toBeNull();
    expect(upload?.form.get("chat_id")).toBe("4242");
    const voice = upload?.form.get("voice");
    expect(voice).toBeInstanceOf(File);
    expect((voice as File).name).toBe("voice.ogg");
    expect((voice as File).type).toBe("audio/ogg");
    expect(await bytesOf(voice ?? null)).toEqual([0x4f, 0x67, 0x67, 0x53]);
  });

  it("a photo send posts sendPhoto with the caller's file name and the caption", async () => {
    const { transport, uploads } = telegram();

    await transport.sendPhoto({ handle: "lifter", image: IMAGE, caption: "lunch" });

    const form = uploads[0]?.form;
    expect(uploads[0]?.method).toBe("sendPhoto");
    expect(form?.get("chat_id")).toBe("4242");
    expect(form?.get("caption")).toBe("lunch");
    expect((form?.get("photo") as File).name).toBe("plate.jpg");
    expect(await bytesOf(form?.get("photo") ?? null)).toEqual([0xff, 0xd8, 0xff]);
  });

  it("a caption over the limit is too-long and makes no request", async () => {
    const { transport, uploads } = telegram();
    const caption = "x".repeat(TELEGRAM_MAX_CAPTION_LENGTH + 1);

    const result = await transport.sendPhoto({ handle: "lifter", image: IMAGE, caption });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "too-long", limit: TELEGRAM_MAX_CAPTION_LENGTH, length: caption.length },
    });
    expect(uploads).toEqual([]);
  });

  it("a rate-limited voice send carries retryAfterSeconds", async () => {
    const { transport } = telegram(
      () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 9",
            parameters: { retry_after: 9 },
          }),
          { status: 429 },
        ),
    );

    const result = await transport.sendVoice({ handle: "lifter", audio: AUDIO });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "rate-limited",
        retryAfterSeconds: 9,
        message: "Too Many Requests: retry after 9",
      },
    });
  });

  it("a voice send to a handle with no chat id is no-chat and makes no request", async () => {
    const uploads: unknown[] = [];
    const transport = new TelegramTransport({
      token: TOKEN,
      chatIdFor: () => undefined,
      fetch: async () => {
        uploads.push(1);
        return accepted(1);
      },
    });

    const result = await transport.sendVoice({ handle: "stranger", audio: AUDIO });

    expect(result).toMatchObject({ ok: false, error: { kind: "no-chat", handle: "stranger" } });
    expect(uploads).toEqual([]);
  });
});

describe("BlueBubbles media sends", () => {
  it("BlueBubbles answers unsupported and makes no request", async () => {
    let requests = 0;
    const transport = new BlueBubblesTransport({
      baseUrl: "http://127.0.0.1:1234",
      password: "fake-password",
      chatGuidFor: () => "iMessage;-;+15555550100",
      fetch: async () => {
        requests += 1;
        return new Response("{}");
      },
    });

    const voice = await transport.sendVoice();
    const photo = await transport.sendPhoto();

    expect(transport.capabilities.media).toBe(false);
    expect(voice).toMatchObject({ ok: false, error: { kind: "unsupported", capability: "media" } });
    expect(photo).toMatchObject({ ok: false, error: { kind: "unsupported", capability: "media" } });
    expect(requests).toBe(0);
  });
});

describe("MockTransport media sends", () => {
  it("MockTransport records both a voice and a photo send", async () => {
    const transport = new MockTransport({ now: () => 5 });

    const voice = await transport.sendVoice({ handle: "+1", audio: AUDIO });
    const photo = await transport.sendPhoto({ handle: "+1", image: IMAGE, caption: "lunch" });

    expect(transport.log).toEqual([
      { type: "sendVoice", at: 5, handle: "+1", audio: AUDIO, ref: { channel: "mock", chat: "+1", messageId: "mock-media-1" } },
      {
        type: "sendPhoto",
        at: 5,
        handle: "+1",
        image: IMAGE,
        caption: "lunch",
        ref: { channel: "mock", chat: "+1", messageId: "mock-media-2" },
      },
    ]);
    expect(voice).toEqual({ ok: true, ref: { channel: "mock", chat: "+1", messageId: "mock-media-1" } });
    expect(photo.ok).toBe(true);
  });

  it("a mock with media off answers unsupported and records nothing", async () => {
    const transport = new MockTransport({ capabilities: { media: false } });

    const result = await transport.sendVoice({ handle: "+1", audio: AUDIO });

    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported", capability: "media" } });
    expect(transport.log).toEqual([]);
  });

  it("a scripted rate limit on sendVoice reaches the caller", async () => {
    const transport = new MockTransport();
    transport.failNext({ kind: "rate-limited", retryAfterSeconds: 4, message: "slow down" }, "sendVoice");

    const result = await transport.sendVoice({ handle: "+1", audio: AUDIO });

    expect(result).toEqual({
      ok: false,
      error: { kind: "rate-limited", retryAfterSeconds: 4, message: "slow down" },
    });
  });
});
