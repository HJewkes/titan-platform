import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const noneStopped = async () => new Set<string>();

async function verb(verdict: string, fetch: typeof globalThis.fetch, task = "demo/DM-1", stoppedPrs: CliDeps["stoppedPrs"] = noneStopped) {
  const file = join(dir, "verdict.txt");
  await writeFile(file, verdict);
  const out = { stdout: "", stderr: "" };
  const io = { stdout: (t: string) => void (out.stdout += t), stderr: (t: string) => void (out.stderr += t), env: { ACTIVE_ROOT: join(dir, "aw") } };
  const deps: CliDeps = { workflows: [], routes: [], fetch, stoppedPrs };
  const code = await runCli(["shepherd", "follow-ups", "octo/widget#7", "--task", task, "--head", HEAD, "--verdict-file", file], io, deps);
  return { code, ...out };
}

describe("shepherd follow-ups", () => {
  it("the verb files a seat verdict's medium follow-up, digests its low one, and prints both", async () => {
    const aw = fakeActiveWork([parent, { id: "DM-2", status: "open", title: "cache the LOOKUP", done_when: "x", notes: "", tags: [] }]);

    const { code, stdout } = await verb(`${BLOCK}\n\nVerdict: MERGE`, aw.fetch);

    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(stdout)).toEqual({ filed: [{ title: "Cache the lookup", id: "DM-2", deduped: true }], digested: ["Name the bound"] });
    expect(aw.tasks.get("DM-1")!.notes).toContain("octo/widget#7");
    expect(await readFile(join(dir, "aw", "demo", "sources", "follow-up-digest.jsonl"), "utf8")).toContain('"title":"Name the bound"');
  });

  it("the verb files nothing, task or digest row, from a PR whose Shepherd run stopped (TP-6714)", async () => {
    const aw = fakeActiveWork([parent]);
    const stopped = async (prs: ReadonlySet<string>) => new Set([...prs].filter((pr) => pr === "octo/widget#7"));

    const { code, stdout } = await verb(`${BLOCK}\n\nVerdict: MERGE`, aw.fetch, "demo/DM-1", stopped);

    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(stdout)).toEqual({ filed: [], digested: [], skipped: "stopped" });
    expect(aw.calls.some((call) => call.command === "task.add" || call.command === "task.edit")).toBe(false);
    await expect(readFile(join(dir, "aw", "demo", "sources", "follow-up-digest.jsonl"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("the verb files nothing and exits 69 when it cannot read whether the PR stopped", async () => {
    const aw = fakeActiveWork([parent]);
    const unread = async () => Promise.reject(new Error("Shepherd's runs could not be read"));

    const { code, stderr } = await verb(BLOCK, aw.fetch, "demo/DM-1", unread);

    expect(code).toBe(EXIT.UNAVAILABLE);
    expect(stderr).toContain("could not be read");
    expect(aw.calls.some((call) => call.command === "task.add")).toBe(false);
  });

  it("the verb prints the named warning for a malformed block, files nothing, and exits 0", async () => {
    const aw = fakeActiveWork([parent]);

    const { code, stdout } = await verb("Follow-ups:\n\nLater.", aw.fetch);

    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(stdout)).toEqual({ filed: [], digested: [], warning: "bad_item" });
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

describe("shepherd follow-ups with an unverifiable task key", () => {
  it("warns on stderr that the key is not verified and still files the follow-ups", async () => {
    const aw = fakeActiveWork([parent]);
    const taskKeysDown = (async (url, init) => {
      if (String(url).includes("/rpc/task.keys")) throw new TypeError("connection refused");
      return aw.fetch(url, init);
    }) as typeof fetch;

    const { code, stderr, stdout } = await verb(BLOCK, taskKeysDown);

    expect(code).toBe(EXIT.OK);
    expect(stderr).toContain("not verified");
    expect(JSON.parse(stdout)).toMatchObject({ filed: [{ title: "Cache the lookup" }], digested: ["Name the bound"] });
  });
});
