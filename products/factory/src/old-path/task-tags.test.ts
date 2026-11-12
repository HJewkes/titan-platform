import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrFile } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import { activeWorkTaskTags, judgeOldPath, taskRef, type TaskTagsPort } from "./task-tags.js";

const REPO = "acme/titan-platform";
const frozen: PrFile = { path: "products/factory/src/shepherd/example.ts", status: "modified" };
const elsewhere: PrFile = { path: "packages/example/src/index.ts", status: "modified" };

function exitedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "old-path-"));
  const milestones = [{ id: "M1b", exited: true }];
  writeFileSync(join(dir, "milestones.json"), JSON.stringify({ milestones }));
  return dir;
}

const envelope = (tasks: unknown[]) => new Response(JSON.stringify({ ok: true, data: { tasks } }), { status: 200 });

describe("old-path task tags", () => {
  it("a bare TP id resolves to titan-platform, CC to claude-channels and TD to titan-design; an unprefixed name is no task", () => {
    expect(taskRef("TP-12")).toEqual({ initiative: "titan-platform", id: "TP-12" });
    expect(taskRef("CC-7")).toEqual({ initiative: "claude-channels", id: "CC-7" });
    expect(taskRef("TD-3")).toEqual({ initiative: "titan-design", id: "TD-3" });
    expect(taskRef("some-name")).toBeUndefined();
  });

  it("a PR that touches no frozen root never calls the task port", async () => {
    const tags = vi.fn<TaskTagsPort["tags"]>(async () => []);

    const verdict = await judgeOldPath({ tags: { tags }, exitedDir: exitedDir() })(REPO, [elsewhere], "TP-1", "correctness");

    expect(verdict).toEqual({ status: "clear", kind: "correctness" });
    expect(tags).not.toHaveBeenCalled();
  });

  it("a task missing from its initiative is no-task, and an rpc failure or timeout is task-unread; both refuse under an active freeze", async () => {
    const missing = judgeOldPath({ tags: { tags: async () => undefined }, exitedDir: exitedDir() });
    const failing = judgeOldPath({ tags: { tags: async () => Promise.reject(new Error("daemon down")) }, exitedDir: exitedDir() });
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const slow = judgeOldPath({ tags: activeWorkTaskTags({ origin: "http://127.0.0.1:1", fetch: hangingFetch, timeoutMs: 20 }), exitedDir: exitedDir() });

    const results = await Promise.all([missing, failing, slow].map((judge) => judge(REPO, [frozen], "TP-1", "feature")));

    expect(results.map((v) => v.status)).toEqual(["no-task", "task-unread", "task-unread"]);
    expect(results.every((v) => "active" in v && v.active)).toBe(true);
  });

  it("the adapter reads one task's tags from task.list over the loopback origin", async () => {
    const fetchFake = vi.fn<typeof fetch>(async () => envelope([{ id: "TP-2", tags: ["other"] }, { id: "TP-1", tags: ["survives:factory"] }]));
    const port = activeWorkTaskTags({ origin: "http://127.0.0.1:7400", fetch: fetchFake });

    const found = await port.tags("titan-platform", "TP-1");
    const absent = await port.tags("titan-platform", "TP-9");

    expect(found).toEqual(["survives:factory"]);
    expect(absent).toBeUndefined();
    const [url, init] = fetchFake.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:7400/rpc/task.list");
    expect(JSON.parse(String(init?.body))).toEqual({ slug: "titan-platform", status: "all" });
  });
});
