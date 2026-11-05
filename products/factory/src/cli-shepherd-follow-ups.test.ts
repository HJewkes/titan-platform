import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import type { CliDeps } from "./cli-types.js";
import { fakeActiveWork } from "./test-support/active-work.js";

const HEAD = "a".repeat(40);
const parent = { id: "DM-1", status: "open", done_when: "Parent done.", notes: "", tags: [] };
const BLOCK = ["Follow-ups:", "- Cache the lookup | A second lookup reads the cache | medium", "- Name the bound | The bound is a constant | low"].join("\n");

let dir: string;
beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), "follow-ups-verb-"))));
afterEach(() => rm(dir, { recursive: true, force: true }));

async function verb(verdict: string, fetch: typeof globalThis.fetch, task = "demo/DM-1") {
  const file = join(dir, "verdict.txt");
  await writeFile(file, verdict);
  const out = { stdout: "", stderr: "" };
  const io = { stdout: (t: string) => void (out.stdout += t), stderr: (t: string) => void (out.stderr += t), env: {} };
  const deps: CliDeps = { workflows: [], routes: [], fetch };
  const code = await runCli(["shepherd", "follow-ups", "octo/widget#7", "--task", task, "--head", HEAD, "--verdict-file", file], io, deps);
  return { code, ...out };
}

describe("shepherd follow-ups", () => {
  it("the verb files a seat verdict's follow-ups and prints the filed and deduped ids", async () => {
    const aw = fakeActiveWork([parent, { id: "DM-2", status: "open", title: "cache the LOOKUP", done_when: "x", notes: "", tags: [] }]);

    const { code, stdout } = await verb(`${BLOCK}\n\nVerdict: MERGE`, aw.fetch);

    expect(code).toBe(EXIT.OK);
    const { filed } = JSON.parse(stdout);
    expect(filed).toEqual([
      { title: "Cache the lookup", id: "DM-2", deduped: true },
      { title: "Name the bound", id: expect.stringMatching(/^FU-/), deduped: false },
    ]);
    expect(aw.tasks.get("DM-1")!.notes).toContain("octo/widget#7");
  });

  it("the verb prints the named warning for a malformed block, files nothing, and exits 0", async () => {
    const aw = fakeActiveWork([parent]);

    const { code, stdout } = await verb("Follow-ups:\n\nLater.", aw.fetch);

    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(stdout)).toEqual({ filed: [], warning: "bad_item" });
    expect(aw.calls.some((call) => call.command === "task.add")).toBe(false);
  });

  it("the verb exits 69 when active-work is down", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const { code, stderr } = await verb(BLOCK, down);

    expect(code).toBe(EXIT.UNAVAILABLE);
    expect(stderr).toContain("error:");
  });

  it("the verb exits 2 for a task with no initiative", async () => {
    const aw = fakeActiveWork([]);

    const { code, stderr } = await verb(BLOCK, aw.fetch, "DM-1");

    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain("DM-1");
  });
});
