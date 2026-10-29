import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcSample } from "@titan-design/daemon";
import { logFileNames, makeLogDir, readLogText, removeDir, seedLog } from "../perf-recorder.test-helpers.js";
import { perfCommands } from "./commands.js";
import { createPerfRecorder, percentile } from "./recorder.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");

function sample(name: string, ms: number, over: Partial<RpcSample> = {}): RpcSample {
  return { name, ms, bytes: 100, status: 200, surface: "http", ...over };
}

let logDir: string;
beforeEach(() => {
  logDir = makeLogDir();
});
afterEach(() => removeDir(logDir));

describe("percentile", () => {
  it("the p95 of 20 samples is the 19th smallest", () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1);

    expect(percentile(sorted, 0.95)).toBe(19);
  });
});

describe("perf recorder", () => {
  it("a sample carries no argument values", async () => {
    const recorder = createPerfRecorder({ dir: logDir, now: () => NOW });
    const withArgs = { ...sample("work.initiative", 5), args: { slug: "secret-x" } };

    recorder.record(withArgs);
    await recorder.close();

    const text = readLogText(logDir);
    expect(text).not.toContain("secret-x");
    expect(JSON.parse(text)).toEqual({ t: NOW, kind: "rpc", name: "work.initiative", ms: 5, bytes: 100, status: 200 });
  });

  it("summarises the last 15 minutes per command with errors counted and the slowest first", async () => {
    const recorder = createPerfRecorder({ dir: logDir, now: () => NOW });
    for (let ms = 1; ms <= 20; ms += 1) recorder.record(sample("work.tasks", ms, { bytes: ms * 10 }));
    recorder.record(sample("work.task", 900, { status: 500 }));

    const { rpcs } = await perfCommands(recorder)["perf.summary"].run({ window: "15m" }, {} as never);
    await recorder.close();

    expect(rpcs.map((row) => row.name)).toEqual(["work.task", "work.tasks"]);
    expect(rpcs[0]).toMatchObject({ count: 1, errors: 1, p95: 900 });
    expect(rpcs[1]).toMatchObject({ count: 20, errors: 0, p50: 10, p95: 19, max: 20, bytesP50: 100, bytesMax: 200 });
  });

  it("the 24 hour summary reads rows from the log, not only the ring", async () => {
    const earlier = NOW - 3 * 3_600_000;
    seedLog(logDir, "rpc-2026-10-29.jsonl", `${JSON.stringify({ t: earlier, kind: "rpc", name: "work.notes", ms: 40, bytes: 9, status: 200 })}\nnot json\n`);
    const recorder = createPerfRecorder({ dir: logDir, now: () => NOW });

    const day = await recorder.summary("24h");
    const quarter = await recorder.summary("15m");
    await recorder.close();

    expect(day).toEqual([expect.objectContaining({ name: "work.notes", count: 1, p95: 40 })]);
    expect(quarter).toEqual([]);
  });

  it("keeps the last ringSize samples in memory", async () => {
    const recorder = createPerfRecorder({ dir: logDir, now: () => NOW, ringSize: 3 });
    for (let i = 1; i <= 5; i += 1) recorder.record(sample("a", i));

    const [row] = await recorder.summary("15m");
    await recorder.close();

    expect(row).toMatchObject({ count: 3, max: 5 });
  });

  it("writes a batch as soon as flushRows are waiting", async () => {
    const recorder = createPerfRecorder({ dir: logDir, now: () => NOW, flushRows: 2 });

    recorder.record(sample("a", 1));
    recorder.record(sample("a", 2));
    await recorder.flush();

    expect(readLogText(logDir).trim().split("\n")).toHaveLength(2);
    await recorder.close();
  });

  it("deletes day files older than the retention at startup and keeps the rest", async () => {
    seedLog(logDir, "rpc-2026-10-01.jsonl", "");
    seedLog(logDir, "rpc-2026-10-25.jsonl", "");
    seedLog(logDir, "notes.txt", "");
    const recorder = createPerfRecorder({ dir: logDir, now: () => NOW, retentionDays: 7 });
    await recorder.close();

    expect(logFileNames(logDir)).toEqual(["notes.txt", "rpc-2026-10-25.jsonl"]);
  });
});
