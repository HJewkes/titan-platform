import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { implementPrompt, loadImplementQueue, semaphore } from "./job.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-i-job-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (candidate: string, kind: string, overrides: Record<string, unknown> = {}) => ({
  candidate,
  id: `${candidate}-implement-x`,
  taskId: "TP-1",
  kind,
  size: "S",
  pkgGroup: "factory",
  mergeSha: "d".repeat(40),
  baseSha: "b".repeat(40),
  brief: "Task: t\nDone when: d",
  hiddenTests: ["products/factory/src/a.test.ts"],
  verdict: "keep",
  nonTestLines: 10,
  ...overrides,
});

describe("implement case queue", () => {
  it("keeps only screened-in cases and spans every kind before repeating one", () => {
    const rows = [row("c1", "correctness"), row("c2", "correctness"), row("f1", "feature"), row("r1", "refactor"), row("d1", "feature", { verdict: "drop", id: null, hiddenTests: [] })];
    writeFileSync(join(dir, "cases.jsonl"), rows.map((entry) => `${JSON.stringify(entry)}\n`).join(""));

    const queue = loadImplementQueue(dir, "bench-2026-11");

    expect(queue.map((entry) => entry.kind)).toEqual(["correctness", "feature", "refactor", "correctness"]);
    expect(queue.map((entry) => entry.stratum)).toContainEqual({ kind: "feature", size: "S", pkg: "factory" });
  });
});

describe("implement prompt", () => {
  it("names the task and ends in its brief", () => {
    const prompt = implementPrompt("TP-9", "Task: t\nDone when: d");

    expect(prompt.startsWith("You are implementing task TP-9 in this repository.")).toBe(true);
    expect(prompt.endsWith("\n\nTask: t\nDone when: d")).toBe(true);
  });
});

describe("scorer semaphore", () => {
  it("never lets more than the limit run at once", async () => {
    const limited = semaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    };

    await Promise.all(Array.from({ length: 6 }, () => limited(task)));

    expect(peak).toBe(2);
  });
});
