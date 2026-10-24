import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { fakeClassifier, workspace, type FakeClassifier, type Workspace } from "./fake-classifier.test-helpers.js";

let ws: Workspace;

beforeEach(() => {
  ws = workspace();
});

afterEach(() => ws.cleanup());

async function cli(fake: FakeClassifier, extra: string[] = []): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const argv = ["--state", ws.state, "self-improve-daily", "--chunks", ws.chunks, "--prompts", ws.prompts, "--out", ws.out, ...extra];
  const code = await runCli(argv, { stdout: (text) => (out += text), stderr: (text) => (err += text), env: {}, runnerFor: fake.runnerFor });
  return { code, out, err };
}

describe("titan-miner self-improve-daily", () => {
  it("prints rows, unparsed counts, skipped chunks and cost per family as JSON", async () => {
    const { code, out } = await cli(fakeClassifier(), ["--max-budget-usd", "2"]);

    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      status: "completed",
      newCalls: 2,
      summary: { rows: { c2_followups: 3 }, unparsed: { c2_followups: 0 }, cost: { c2_followups: 0.1 }, skipped: [], failed: [], spentUsd: 0.1 },
    });
  });

  it("makes no new model calls on a second invocation over the same chunks", async () => {
    await cli(fakeClassifier());
    const second = fakeClassifier();

    const { code, out } = await cli(second);

    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ status: "completed", newCalls: 0, summary: { rows: { c2_followups: 3 } } });
    expect(second.chunks).toEqual([]);
  });

  it("exits 64 when the chunk dir is missing", async () => {
    rmSync(ws.chunks, { recursive: true });

    const { code, err } = await cli(fakeClassifier());

    expect(code).toBe(64);
    expect(err).toContain("--chunks");
  });

  it("exits 64 when a family with chunks has no prompt file", async () => {
    rmSync(path.join(ws.prompts, "c2_followups.md"));
    const fake = fakeClassifier();

    const { code, err } = await cli(fake);

    expect(code).toBe(64);
    expect(err).toContain("c2_followups.md");
    expect(fake.chunks).toEqual([]);
  });

  it("exits 64 on a budget that is not a positive number", async () => {
    const { code, err } = await cli(fakeClassifier(), ["--max-budget-usd", "lots"]);

    expect(code).toBe(64);
    expect(err).toContain("--max-budget-usd");
  });
});
