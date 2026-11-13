import { describe, expect, it } from "vitest";
import type { FollowUp } from "@titan-design/review-panel";
import { fakeActiveWork } from "../test-support/active-work.js";
import { activeWorkFollowUpTasks } from "./cleanup-ports.js";
import { fileFollowUps, type FollowUpWhere } from "./follow-ups-file.js";

const ORIGIN = "http://127.0.0.1:7400";
const WHERE: FollowUpWhere = { initiative: "demo", parent: "DM-1", repo: "octo/widget", pr: 7, head: "abcdef0123456789", reviewer: "rev-1" };
const item = (title: string, severity: FollowUp["severity"] = "low"): FollowUp => ({ title, doneWhen: `${title} is done and verified.`, severity });
const parent = { id: "DM-1", status: "open", done_when: "Parent done.", notes: "", tags: [] };
const other = (status: string, title: string) => ({ id: "DM-2", status, title, done_when: "x", notes: "", tags: [] });

function setup(tasks: Parameters<typeof fakeActiveWork>[0] = [parent]) {
  const aw = fakeActiveWork(tasks);
  return { aw, port: activeWorkFollowUpTasks({ origin: ORIGIN, fetch: aw.fetch }) };
}

describe("fileFollowUps", () => {
  it("files each follow-up as an open task tagged follow-up:<parent> with the reviewer's done_when and severity", async () => {
    const { aw, port } = setup();
    const { filed } = await fileFollowUps(port, WHERE, [item("Rename helper", "medium")]);
    const task = aw.tasks.get(filed[0]!.id)!;
    expect(filed).toEqual([{ title: "Rename helper", id: task.id, deduped: false }]);
    expect(task).toMatchObject({ status: "open", severity: "medium", tags: ["follow-up:DM-1"], done_when: "Rename helper is done and verified." });
    expect(task.notes).toContain("rev-1");
    expect(task.notes).toContain("octo/widget#7");
  });

  it("shepherd follow-up carries from_pr and from_task", async () => {
    const { aw, port } = setup();
    const { filed } = await fileFollowUps(port, WHERE, [item("Rename helper")]);
    expect(aw.tasks.get(filed[0]!.id)).toMatchObject({ source: "follow-up", source_ref: { from_pr: "octo/widget#7", from_task: "DM-1" } });
  });

  it("shepherd follow-up carries class", async () => {
    const { aw, port } = setup([{ ...parent, class: "upkeep" }]);
    const { filed } = await fileFollowUps(port, WHERE, [item("Rename helper")]);
    expect(aw.tasks.get(filed[0]!.id)?.class).toBe("upkeep");
  });

  it("a follow-up of a parent task with no class is filed with no class", async () => {
    const { aw, port } = setup();
    const { filed } = await fileFollowUps(port, WHERE, [item("Rename helper")]);
    expect(aw.calls.find((call) => call.command === "task.add")?.body).not.toHaveProperty("class");
    expect(aw.tasks.get(filed[0]!.id)?.class).toBeUndefined();
  });

  it("reads the parent's class once however many follow-ups it files, and not at all when every one dedupes", async () => {
    const { aw, port } = setup([{ ...parent, class: "product" }, other("open", "Already open")]);
    const classReads = () => aw.calls.filter((call) => call.command === "task.list" && call.body.status === "all").length;
    await fileFollowUps(port, WHERE, [item("Already open")]);
    const afterDedupe = classReads();
    await fileFollowUps(port, WHERE, [item("Rename helper"), item("Other nit")]);
    expect([...aw.tasks.values()].filter((task) => task.source === "follow-up").map((task) => task.class)).toEqual(["product", "product"]);
    expect(classReads() - afterDedupe).toBe(1 + 2);
    expect(afterDedupe).toBe(1);
  });

  it("links each filed follow-up from the parent task's notes once", async () => {
    const { aw, port } = setup();
    const first = await fileFollowUps(port, WHERE, [item("Rename helper")]);
    await fileFollowUps(port, WHERE, [item("Rename helper")]);
    const line = `Follow-up ${first.filed[0]!.id} filed from octo/widget#7 review at abcdef01: Rename helper`;
    expect(aw.tasks.get("DM-1")!.notes.split(line)).toHaveLength(2);
  });

  it("dedupes a follow-up whose title matches an open task after trimming, whitespace folding and case folding", async () => {
    const { aw, port } = setup([parent, other("open", "rename   Helper")]);
    const { filed } = await fileFollowUps(port, WHERE, [item("  Rename helper ")]);
    expect(filed).toEqual([{ title: "  Rename helper ", id: "DM-2", deduped: true }]);
    expect(aw.calls.some((call) => call.command === "task.add")).toBe(false);
  });

  it("files a follow-up again when the only same-titled task is done", async () => {
    const { port } = setup([parent, other("done", "Rename helper")]);
    const { filed } = await fileFollowUps(port, WHERE, [item("Rename helper")]);
    expect(filed[0]).toMatchObject({ deduped: false });
    expect(filed[0]!.id).not.toBe("DM-2");
  });

  it("files two same-titled items in one block once", async () => {
    const { aw, port } = setup();
    const { filed } = await fileFollowUps(port, WHERE, [item("Rename helper"), item("RENAME helper", "high")]);
    expect(filed).toHaveLength(1);
    expect(aw.calls.filter((call) => call.command === "task.add")).toHaveLength(1);
  });

  it("a re-run after a partial filing returns the ids already filed and adds nothing", async () => {
    const { aw, port } = setup();
    const first = await fileFollowUps(port, WHERE, [item("Rename helper")]);
    const adds = aw.calls.filter((call) => call.command === "task.add").length;
    const again = await fileFollowUps(port, WHERE, [item("Rename helper"), item("Other nit")]);
    expect(again.filed[0]).toEqual({ title: "Rename helper", id: first.filed[0]!.id, deduped: true });
    expect(aw.calls.filter((call) => call.command === "task.add")).toHaveLength(adds + 1);
  });
});
