import { describe, expect, it } from "vitest";
import { activeWorkDocTasks } from "./task-source.js";

const ORIGIN = "http://127.0.0.1:7400";

const DOCS_TASK = { id: "D-7", title: "Explain the retry flag", status: "open", done_when: "The guide names the retry flag and its default.", notes: "private context that never leaves the daemon", tags: ["docs"] };

function daemon(tasks: unknown[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, data: { tasks } }));
  };
  return { fetch, calls };
}

describe("activeWorkDocTasks", () => {
  it("reads the task's title, done_when and status from its initiative's list", async () => {
    const { fetch, calls } = daemon([{ id: "D-6", title: "other", status: "done" }, DOCS_TASK]);

    const task = await activeWorkDocTasks({ origin: ORIGIN, fetch }).read("demo", "D-7");

    expect(calls).toEqual([{ url: `${ORIGIN}/rpc/task.list`, body: { slug: "demo", status: "all" } }]);
    expect(task).toEqual({ slug: "demo", id: "D-7", title: "Explain the retry flag", status: "open", done_when: "The guide names the retry flag and its default." });
  });

  it("leaves the notes out of the record even when the daemon returns them", async () => {
    const { fetch } = daemon([DOCS_TASK]);

    const task = await activeWorkDocTasks({ origin: ORIGIN, fetch }).read("demo", "D-7");

    expect(task).not.toHaveProperty("notes");
    expect(JSON.stringify(task)).not.toContain("private context");
  });

  it("refuses a task with no done_when, since the draft has nothing to answer", async () => {
    const { fetch } = daemon([{ ...DOCS_TASK, done_when: undefined }]);

    await expect(activeWorkDocTasks({ origin: ORIGIN, fetch }).read("demo", "D-7")).rejects.toThrow("demo/D-7 has no done_when");
  });

  it("refuses a task the initiative does not list", async () => {
    const { fetch } = daemon([]);

    await expect(activeWorkDocTasks({ origin: ORIGIN, fetch }).read("demo", "D-7")).rejects.toThrow("no task demo/D-7");
  });
});
