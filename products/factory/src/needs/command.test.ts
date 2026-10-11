import { ownerItemSchema } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import { failingSource, sources10_05 } from "../test-support/needs-10-05.js";
import { runNeeds } from "./command.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) } };
}

describe("runNeeds", () => {
  it("prints the merged list as text", async () => {
    const { out, io } = capture();

    const code = await runNeeds(io, await sources10_05(), { json: false });

    expect(code).toBe(0);
    expect(out.join("")).toMatch(/^36 gates, 88 Morning items, 145 tasks, 19 broker items/);
  });

  it("emits OwnerItem[] as JSON with --json", async () => {
    const { out, io } = capture();

    await runNeeds(io, await sources10_05(), { json: true });

    const items: unknown[] = JSON.parse(out.join(""));
    expect(items).toHaveLength(283);
    for (const item of items) expect(() => ownerItemSchema.parse(item)).not.toThrow();
  });

  it("exits unavailable when a source cannot be read, still printing the rest", async () => {
    const { out, err, io } = capture();

    const code = await runNeeds(io, [...(await sources10_05()).slice(1), failingSource("agent-chat", "down")], { json: true });

    expect(code).toBe(69);
    expect(err.join("")).toBe("agent-chat: down\n");
    expect(JSON.parse(out.join(""))).toHaveLength(264);
  });
});
