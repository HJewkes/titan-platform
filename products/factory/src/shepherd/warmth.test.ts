import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_FILL, WARM_MINUTES, isWarm, readWarmth } from "./warmth.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MINUTE = 60_000;

function assistant(ts: string, tokens: { input: number; read: number; created: number }, extra: Record<string, unknown> = {}): string {
  const usage = { input_tokens: tokens.input, cache_read_input_tokens: tokens.read, cache_creation_input_tokens: tokens.created, output_tokens: 5 };
  const message = { id: `msg-${ts}`, model: "demo-model", role: "assistant", content: [{ type: "text", text: "ok" }], usage };
  return JSON.stringify({ type: "assistant", sessionId: "session-1", timestamp: ts, requestId: `req-${ts}`, message, ...extra });
}

const user = (ts: string, text = "next") => JSON.stringify({ type: "user", sessionId: "session-1", timestamp: ts, message: { role: "user", content: text } });

function transcript(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "warmth-"));
  dirs.push(dir);
  const path = join(dir, "session-1.jsonl");
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
  return path;
}

describe("readWarmth", () => {
  it("reports the newest event time and the last request's context tokens", async () => {
    const path = transcript([assistant("2026-01-01T00:00:00.000Z", { input: 1, read: 10, created: 100 }), assistant("2026-01-01T00:05:00.000Z", { input: 2, read: 20, created: 200 }), user("2026-01-01T00:06:00.000Z")]);

    expect(await readWarmth(path)).toEqual({ lastEventAt: T0 + 6 * MINUTE, fill: 222 });
  });

  it("ignores a subagent's request, whose context is not the session's", async () => {
    const path = transcript([assistant("2026-01-01T00:00:00.000Z", { input: 1, read: 2, created: 3 }), assistant("2026-01-01T00:01:00.000Z", { input: 900, read: 900, created: 900 }, { isSidechain: true })]);

    expect((await readWarmth(path))?.fill).toBe(6);
  });

  it("reads only the tail, starting on a line boundary inside it", async () => {
    const early = assistant("2026-01-01T00:00:00.000Z", { input: 1, read: 1, created: 1 });
    const late = assistant("2026-01-01T00:09:00.000Z", { input: 7, read: 0, created: 0 });
    const path = transcript([early, user("2026-01-01T00:01:00.000Z", "x".repeat(4_000)), late]);

    expect(await readWarmth(path, late.length + 10)).toEqual({ lastEventAt: T0 + 9 * MINUTE, fill: 7 });
  });

  it("is undefined for a missing transcript or one with no request", async () => {
    expect(await readWarmth(join(tmpdir(), "no-such-dir-for-warmth", "gone.jsonl"))).toBeUndefined();
    expect(await readWarmth(transcript([user("2026-01-01T00:00:00.000Z")]))).toBeUndefined();
  });
});

describe("isWarm", () => {
  const warmth = { lastEventAt: T0, fill: 1_000 };

  it("is warm just inside the window and cold at its edge", () => {
    expect(isWarm(warmth, T0 + (WARM_MINUTES - 1) * MINUTE)).toBe(true);
    expect(isWarm(warmth, T0 + WARM_MINUTES * MINUTE)).toBe(false);
  });

  it("is cold at the fill limit even when recent", () => {
    expect(isWarm({ lastEventAt: T0, fill: MAX_FILL - 1 }, T0 + MINUTE)).toBe(true);
    expect(isWarm({ lastEventAt: T0, fill: MAX_FILL }, T0 + MINUTE)).toBe(false);
  });

  it("is never warm when the warmth is unknown", () => {
    expect(isWarm(undefined, T0)).toBe(false);
  });
});
