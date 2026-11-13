import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { olderDaemonFetch, taskIndexFetch } from "../test-support/task-index.js";
import { loadTaskIndex, qualifyTask, TaskKeyRefused } from "./task-ref.js";

const origin = "http://127.0.0.1:7400";
const TASKS = [{ id: "CC-784", slug: "chan" }, { id: "TP-1", slug: "titan-platform" }];

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "task-ref-root-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

function archive(slug: string, id: string): void {
  mkdirSync(join(root, slug, "tasks", "archive"), { recursive: true });
  writeFileSync(join(root, slug, "tasks", "archive", `${id}.yml`), "");
}

describe("qualifyTask", () => {
  it("resolves a bare ID that one initiative owns", async () => {
    await expect(qualifyTask("CC-784", { origin, fetch: taskIndexFetch(TASKS) })).resolves.toEqual({ key: "chan/CC-784", verified: true });
  });

  it("keeps a key whose initiative holds the task", async () => {
    await expect(qualifyTask("titan-platform/TP-1", { origin, fetch: taskIndexFetch(TASKS) })).resolves.toEqual({ key: "titan-platform/TP-1", verified: true });
  });

  it("refuses a key with another initiative's prefix rather than correcting it", async () => {
    const refused = qualifyTask("titan-platform/CC-784", { origin, fetch: taskIndexFetch(TASKS) });
    await expect(refused).rejects.toBeInstanceOf(TaskKeyRefused);
    await expect(refused).rejects.toThrow("refused (wrong-initiative): task CC-784 is in chan, not titan-platform; pass --task <initiative>/<ID>");
  });

  it("refuses a bare ID no initiative has, naming the expected form", async () => {
    await expect(qualifyTask("CC-9999", { origin, fetch: taskIndexFetch(TASKS) })).rejects.toThrow("task CC-9999 is in no initiative; pass --task <initiative>/<ID>");
  });

  it("refuses a bare ID that several initiatives share and no prefix settles", async () => {
    const fetch = taskIndexFetch([{ id: "X-1", slug: "a" }, { id: "X-1", slug: "b" }], [{ slug: "a", task_prefix: "A" }, { slug: "b", task_prefix: "B" }]);
    await expect(qualifyTask("X-1", { origin, fetch })).rejects.toThrow("is in 2 initiatives (a, b); pass --task <initiative>/<ID>");
  });

  it("stores a key as given, unverified, when the daemon cannot be reached", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Promise.reject(new Error("connection refused")));
    await expect(qualifyTask("chan/CC-784", { origin, fetch, activeRoot: root })).resolves.toMatchObject({ key: "chan/CC-784", verified: false, warning: expect.stringContaining("not verified") });
  });

  it("still refuses a malformed key when the daemon cannot be reached", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Promise.reject(new Error("connection refused")));
    await expect(qualifyTask("chan/fix-the-thing", { origin, fetch, activeRoot: root })).rejects.toThrow("refused (malformed)");
  });
});

describe("qualifyTask against a daemon older than task.keys", () => {
  it("resolves an open task through task.list", async () => {
    await expect(qualifyTask("CC-784", { origin, fetch: olderDaemonFetch(TASKS), activeRoot: root })).resolves.toEqual({ key: "chan/CC-784", verified: true });
  });

  it("resolves an archived task from the archive file names", async () => {
    archive("chan", "CC-12");
    await expect(qualifyTask("CC-12", { origin, fetch: olderDaemonFetch(TASKS), activeRoot: root })).resolves.toEqual({ key: "chan/CC-12", verified: true });
  });

  it("still refuses a wrong-initiative key and a key no task file has", async () => {
    await expect(qualifyTask("titan-platform/CC-784", { origin, fetch: olderDaemonFetch(TASKS), activeRoot: root })).rejects.toThrow("refused (wrong-initiative)");
    await expect(qualifyTask("chan/CC-9", { origin, fetch: olderDaemonFetch(TASKS), activeRoot: root })).rejects.toThrow("refused (not-found)");
  });

  it("stores a key it cannot find as unverified when the archives cannot be listed", async () => {
    const missingRoot = join(root, "absent");
    await expect(qualifyTask("chan/CC-9", { origin, fetch: olderDaemonFetch(TASKS), activeRoot: missingRoot })).resolves.toMatchObject({ key: "chan/CC-9", verified: false });
  });
});

describe("loadTaskIndex", () => {
  it("maps each initiative's task prefix and keeps only agent-visible initiatives as visible", async () => {
    const fetch = taskIndexFetch(TASKS, [{ slug: "chan", task_prefix: "CC" }, { slug: "titan-platform", task_prefix: "TP", agent_visible: false }]);

    const { index, agentVisible } = await loadTaskIndex({ origin, fetch });

    expect(index.prefixes).toEqual([{ initiative: "chan", taskPrefix: "CC" }, { initiative: "titan-platform", taskPrefix: "TP" }]);
    expect([...agentVisible]).toEqual(["chan"]);
  });
});
