import path from "node:path";
import type { Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryBreaker } from "./breaker.js";
import { tempTree, type TempTree } from "./fixtures.test-helpers.js";
import { getVideo, openScoutDb } from "./store.js";
import type { RunResult, Runner } from "./transcribe.js";
import { runTranscribeQueue, type QueueEnv } from "./transcribe-queue.js";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const hoursAhead = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

let tree: TempTree;
let db: Db;

beforeEach(() => {
  tree = tempTree();
  db = openScoutDb(path.join(tree.root, "scout.sqlite3"));
});
afterEach(() => {
  db.close();
  tree.cleanup();
});

function addVideo(id: string, over: { published?: string; state?: string; attempts?: number; last_error_class?: string | null; next_retry_at?: string | null; detected_at?: string } = {}) {
  db.prepare("INSERT INTO videos (id, source, kind, detected_at, published, state, attempts, next_retry_at, last_error_class) VALUES (?, 'confTalks', 'vod', ?, ?, ?, ?, ?, ?)").run(
    id,
    over.detected_at ?? hoursAgo(1),
    over.published ?? hoursAgo(2),
    over.state ?? "new",
    over.attempts ?? 0,
    over.next_retry_at ?? null,
    over.last_error_class ?? null,
  );
}

const wrote = (id: string, source: string): RunResult => {
  const file = path.join(tree.root, `${id}.md`);
  tree.write(`${id}.md`, "---\nid: x\n---\n\n[00:00] one two three four\n");
  return { code: 0, stdout: `Wrote ${file} (30 chars from ${source})\n`, stderr: "" };
};
const failure = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });

function harness(reply: (id: string, argv: string[]) => RunResult, load = 1) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const runner: Runner = async (command, args) => {
    calls.push([command, ...args]);
    const url = args.find((a) => a.startsWith("https://"))!;
    return reply(url.split("v=")[1]!, [command, ...args]);
  };
  const env: QueueEnv = {
    ytRoot: path.join(tree.root, "yt"),
    runner,
    now: () => NOW,
    load5: () => load,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    breaker: memoryBreaker(),
  };
  return { env, calls, sleeps };
}

describe("transcribe queue", () => {
  it("marks a video transcribed with its source and word count", async () => {
    addVideo("vvvvvvvvv01");
    const h = harness((id) => wrote(id, "auto-generated subtitles"));

    const report = await runTranscribeQueue(db, h.env);

    expect(report.transcribed).toEqual(["vvvvvvvvv01"]);
    expect(getVideo(db, "vvvvvvvvv01")).toMatchObject({ state: "transcribed", attempts: 1 });
  });

  it("opens the breaker on a 429 and stops the queue", async () => {
    addVideo("vvvvvvvvv01");
    addVideo("vvvvvvvvv02");
    const h = harness(() => failure("ERROR: HTTP Error 429: Too Many Requests"));

    const report = await runTranscribeQueue(db, h.env);

    expect(h.calls).toHaveLength(1);
    expect(report.breakerOpen).toBe(true);
    expect(h.env.breaker.read()).toEqual({ openUntil: hoursAhead(2), cooldownMs: 2 * 3_600_000 });
    expect(getVideo(db, "vvvvvvvvv01")).toMatchObject({ state: "new", attempts: 0, last_error_class: "http429", next_retry_at: hoursAhead(2) });
  });

  it("pulls nothing while the breaker is open, and does not fall back to Whisper", async () => {
    addVideo("vvvvvvvvv01");
    addVideo("vvvvvvvvv02", { last_error_class: "no_captions", published: hoursAgo(30) });
    const h = harness((id) => wrote(id, "whisper"));
    h.env.breaker.write({ openUntil: hoursAhead(1), cooldownMs: 2 * 3_600_000 });

    const report = await runTranscribeQueue(db, h.env);

    expect(h.calls).toEqual([]);
    expect(report.breakerOpen).toBe(true);
  });

  it("doubles the cooldown on a repeat trip up to 24 h, and resets it on a success", async () => {
    addVideo("vvvvvvvvv01");
    const h = harness(() => failure("HTTP Error 429"));
    h.env.breaker.write({ openUntil: hoursAgo(1), cooldownMs: 16 * 3_600_000 });
    await runTranscribeQueue(db, h.env);
    expect(h.env.breaker.read().cooldownMs).toBe(24 * 3_600_000);

    db.prepare("UPDATE videos SET next_retry_at = NULL").run();
    const ok = harness((id) => wrote(id, "subtitles"));
    ok.env.breaker.write({ openUntil: hoursAgo(1), cooldownMs: 8 * 3_600_000 });
    await runTranscribeQueue(db, ok.env);
    expect(ok.env.breaker.read()).toEqual({ openUntil: null, cooldownMs: 0 });
  });

  it("reschedules no_captions on a video under 24 h old at +6 h", async () => {
    addVideo("vvvvvvvvv01", { published: hoursAgo(3) });
    const h = harness(() => failure("ERROR: There are no subtitles for the requested languages"));

    await runTranscribeQueue(db, h.env);

    expect(getVideo(db, "vvvvvvvvv01")).toMatchObject({ state: "new", attempts: 1, last_error_class: "no_captions", next_retry_at: hoursAhead(6) });
  });

  it("queues a no_captions video older than 24 h for Whisper, which runs niced", async () => {
    addVideo("vvvvvvvvv01", { published: hoursAgo(30) });
    const h = harness((id, argv) => (argv.includes("--whisper") ? wrote(id, "whisper (base.en)") : failure("no subtitles")));

    const report = await runTranscribeQueue(db, h.env);

    expect(report.transcribed).toEqual(["vvvvvvvvv01"]);
    expect(h.calls.at(-1)!.slice(0, 3)).toEqual(["nice", "-n", "19"]);
    expect(h.calls[0]![0]).not.toBe("nice");
  });

  it("refuses Whisper when the 5-minute load reads 15", async () => {
    addVideo("vvvvvvvvv01", { published: hoursAgo(30), last_error_class: "no_captions", attempts: 1 });
    const h = harness((id) => wrote(id, "whisper"), 15);

    const report = await runTranscribeQueue(db, h.env);

    expect(h.calls).toEqual([]);
    expect(report.whisperRefused).toEqual(["vvvvvvvvv01"]);
    expect(getVideo(db, "vvvvvvvvv01")!.state).toBe("new");
  });

  it("runs at most 2 Whisper jobs a tick", async () => {
    for (const n of [1, 2, 3]) addVideo(`vvvvvvvvv0${n}`, { published: hoursAgo(30), last_error_class: "no_captions", attempts: 1 });
    const h = harness((id) => wrote(id, "whisper"));

    const report = await runTranscribeQueue(db, h.env);

    expect(report.transcribed).toHaveLength(2);
  });

  it("fails a video on its fifth failed attempt", async () => {
    addVideo("vvvvvvvvv01", { attempts: 4 });
    const h = harness(() => failure("ERROR: something unexpected"));

    await runTranscribeQueue(db, h.env);

    expect(getVideo(db, "vvvvvvvvv01")).toMatchObject({ state: "failed", attempts: 5, last_error_class: "other" });
  });

  it("retries a live video later and gives up as failed:live after 48 h", async () => {
    addVideo("vvvvvvvvv01", { detected_at: hoursAgo(1) });
    addVideo("vvvvvvvvv02", { detected_at: hoursAgo(49) });
    const h = harness(() => failure("ERROR: This live event will begin in 2 hours"));

    await runTranscribeQueue(db, h.env);

    expect(getVideo(db, "vvvvvvvvv01")).toMatchObject({ state: "new", last_error_class: "upcoming", next_retry_at: hoursAhead(6) });
    expect(getVideo(db, "vvvvvvvvv02")!.state).toBe("failed:live");
  });

  it("spaces videos 6 s apart, jittered, and skips ones not yet due", async () => {
    addVideo("vvvvvvvvv01");
    addVideo("vvvvvvvvv02");
    addVideo("vvvvvvvvv03", { next_retry_at: hoursAhead(3) });
    const h = harness((id) => wrote(id, "subtitles"));

    const report = await runTranscribeQueue(db, h.env);

    expect(report.transcribed).toEqual(["vvvvvvvvv01", "vvvvvvvvv02"]);
    expect(h.sleeps).toEqual([6000]);
  });
});
