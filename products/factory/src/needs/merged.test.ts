import { ownerItemSchema } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import { OVERLAP_LINES, TASK_COUNT, decisionTask } from "../test-support/owner-queue-10-05.js";
import { decisionTaskItem } from "./active-work-source.js";
import { collectNeeds, renderNeeds } from "./merged.js";
import { failingSource, sources10_05 } from "../test-support/needs-10-05.js";

describe("collectNeeds on the synthetic 10-05 queue", () => {
  it("shows 36 gates, 88 Morning items, 145 tasks and the broker items by kind", async () => {
    const list = await collectNeeds(await sources10_05());

    const [summary] = renderNeeds(list).split("\n");

    expect(summary).toBe("36 gates, 88 Morning items, 145 tasks, 19 broker items (approve 3, decide 2, know 14)");
  });

  it("merges each duplicate into one item and names what it was merged from", async () => {
    const list = await collectNeeds(await sources10_05());
    const text = renderNeeds(list);

    expect(list.items).toHaveLength(36 + 88 + 145 + 19 - 5);
    expect(text).toContain("2 items merged into 1: hitl g-01 + morning seat-a:1");
    expect(text).toContain("7 overlaps, 5 merged, 2 shown more than once");
    for (const line of OVERLAP_LINES) expect(text).toContain(line);
  });

  it("leaves personal initiatives out of the list", async () => {
    const personal = decisionTaskItem({ ...decisionTask(1), slug: "diary" }, true);
    const open = decisionTaskItem(decisionTask(2), false);

    const list = await collectNeeds(await sources10_05([personal, open]));

    expect(list.items.map((item) => item.id)).not.toContain(personal.id);
    expect(list.items.map((item) => item.id)).toContain(open.id);
    expect(renderNeeds(list)).toContain("1 tasks");
  });

  it("turns a source that cannot be read into a gap and keeps the others", async () => {
    const list = await collectNeeds([...(await sources10_05()).slice(1), failingSource("agent-chat", "connect ECONNREFUSED\nmore")]);

    expect(list.gaps).toEqual(["agent-chat: connect ECONNREFUSED"]);
    expect(list.items).toHaveLength(36 + 88 + 145 - 5);
  });

  it("holds only schema-valid OwnerItems", async () => {
    const list = await collectNeeds(await sources10_05());

    for (const item of list.items) expect(() => ownerItemSchema.parse(item)).not.toThrow();
    expect(TASK_COUNT).toBe(145);
  });
});
