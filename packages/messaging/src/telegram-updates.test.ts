import { describe, expect, it } from "vitest";
import type { TelegramConfig } from "./telegram.js";
import { pollUpdates, readChatIds } from "./telegram-updates.js";

const TOKEN = "123456789:AAH-fake-bot-token_for-tests";
const UPDATES_URL = `https://api.telegram.org/bot${TOKEN}/getUpdates`;
const CHAT = 4242;

function textUpdate(updateId: number, text: string, chatId = CHAT): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1757808000,
      text,
      from: { id: 99, is_bot: false, first_name: "Lifter" },
      chat: { id: chatId, type: "private" },
    },
  };
}

function envelope(result: unknown[]): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { "content-type": "application/json" },
  });
}

/** Answers each poll from `batches`, then blocks so the caller has to abort. */
function scriptedFetch(batches: unknown[][]): {
  fetch: typeof fetch;
  bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  const doFetch: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const batch = batches[call];
    call += 1;
    if (!batch) return await new Promise<Response>(() => {});
    return envelope(batch);
  };
  return { fetch: doFetch, bodies };
}

function configWith(doFetch: typeof fetch): TelegramConfig {
  return { token: TOKEN, chatIdFor: () => CHAT, fetch: doFetch };
}

async function collect(
  iterator: AsyncGenerator<{ updateId: number; text: string }>,
  count: number,
): Promise<Array<{ updateId: number; text: string }>> {
  const seen: Array<{ updateId: number; text: string }> = [];
  for await (const update of iterator) {
    seen.push(update);
    if (seen.length === count) break;
  }
  return seen;
}

describe("pollUpdates", () => {
  it("yields text updates and advances the offset past the last update_id", async () => {
    const scripted = scriptedFetch([
      [textUpdate(101, "one"), textUpdate(102, "two")],
      [textUpdate(103, "three")],
    ]);

    const updates = await collect(
      pollUpdates(configWith(scripted.fetch), {
        timeoutSeconds: 30,
        allowedChatIds: [CHAT],
      }),
      3,
    );

    expect(updates.map((update) => update.text)).toEqual(["one", "two", "three"]);
    expect(scripted.bodies).toEqual([
      { timeout: 30 },
      { offset: 103, timeout: 30 },
    ]);
  });

  it("yields the whole shape of a text message", async () => {
    const scripted = scriptedFetch([[textUpdate(7, "ready")]]);

    const [update] = await collect(
      pollUpdates(configWith(scripted.fetch), {
        timeoutSeconds: 1,
        allowedChatIds: [CHAT],
      }),
      1,
    );

    expect(update).toEqual({
      updateId: 7,
      chatId: CHAT,
      fromId: 99,
      text: "ready",
      date: 1757808000,
    });
  });

  it("skips other chats, non-text updates and unreadable shapes, but still acks them", async () => {
    const scripted = scriptedFetch([
      [
        textUpdate(201, "from a stranger", 9999),
        { update_id: 202, edited_message: { text: "edited" } },
        { update_id: 203, message: { date: 1, chat: { id: CHAT }, photo: [] } },
        { nonsense: true },
        textUpdate(204, "mine"),
      ],
    ]);

    const updates = await collect(
      pollUpdates(configWith(scripted.fetch), {
        timeoutSeconds: 1,
        allowedChatIds: [CHAT],
      }),
      1,
    );

    expect(updates.map((update) => update.text)).toEqual(["mine"]);
    expect(scripted.bodies).toEqual([{ timeout: 1 }]);
  });

  it("matches an allowlist entry written as a string", async () => {
    const scripted = scriptedFetch([[textUpdate(1, "hi")]]);

    const updates = await collect(
      pollUpdates(configWith(scripted.fetch), {
        timeoutSeconds: 1,
        allowedChatIds: ["4242"],
      }),
      1,
    );

    expect(updates).toHaveLength(1);
  });

  it("stops cleanly when the signal aborts mid-poll", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("aborted", "AbortError");
    const doFetch: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(abortError);
        init?.signal?.addEventListener("abort", () => {
          reject(abortError);
        });
      });

    const iterator = pollUpdates(configWith(doFetch), {
      timeoutSeconds: 30,
      allowedChatIds: [CHAT],
      signal: controller.signal,
    });
    const drained = (async () => {
      const seen: unknown[] = [];
      for await (const update of iterator) seen.push(update);
      return seen;
    })();
    controller.abort();

    await expect(drained).resolves.toEqual([]);
  });

  it("does not poll at all when the signal is already aborted", async () => {
    let called = false;
    const controller = new AbortController();
    controller.abort();

    const first = await pollUpdates(
      configWith(async () => {
        called = true;
        return envelope([]);
      }),
      { timeoutSeconds: 30, allowedChatIds: [CHAT], signal: controller.signal },
    ).next();

    expect(first.done).toBe(true);
    expect(called).toBe(false);
  });

  it("throws a redacted error when the API rejects the poll", async () => {
    const iterator = pollUpdates(
      configWith(
        async () =>
          new Response(
            JSON.stringify({ ok: false, description: `Unauthorized ${TOKEN}` }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      ),
      { timeoutSeconds: 1, allowedChatIds: [CHAT] },
    );

    const failure = await iterator.next().then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(String(failure)).toMatch(/getUpdates failed \(401\)/);
    expect(String(failure)).not.toContain(TOKEN);
  });

  it("keeps the token out of a fetch error that embeds the whole url", async () => {
    const iterator = pollUpdates(
      configWith(async () => {
        throw new TypeError(`request to ${UPDATES_URL} failed, reason: ECONNREFUSED`);
      }),
      { timeoutSeconds: 1, allowedChatIds: [CHAT] },
    );

    const failure = await iterator.next().then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(String(failure)).toContain("***");
    expect(String(failure)).not.toContain(TOKEN);
  });
});

describe("readChatIds", () => {
  it("returns the distinct chat ids of one short poll without acking", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const ids = await readChatIds(
      configWith(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return envelope([
          textUpdate(1, "a"),
          textUpdate(2, "b"),
          textUpdate(3, "c", 777),
          { update_id: 4 },
        ]);
      }),
    );

    expect(ids).toEqual([CHAT, 777]);
    expect(bodies).toEqual([{ timeout: 0 }]);
  });

  it("keeps the token out of a fetch error that embeds the whole url", async () => {
    const failure = await readChatIds(
      configWith(async () => {
        throw new TypeError(`request to ${UPDATES_URL} failed, reason: ECONNREFUSED`);
      }),
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(String(failure)).toContain("***");
    expect(String(failure)).not.toContain(TOKEN);
  });
});
