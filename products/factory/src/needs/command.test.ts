import { ownerItemSchema } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { failingSource, sources10_05 } from "../test-support/needs-10-05.js";
import { needsDaemon, shownTask, withheldTask } from "../test-support/needs-daemon.js";
import { decisionTaskItem } from "./active-work-source.js";
import { runNeeds, shellNeedsView } from "./command.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) } };
}

describe("runNeeds", () => {
  it("prints the merged list as text", async () => {
    const { out, io } = capture();

    const code = await runNeeds(io, await sources10_05(), { json: false }, { caller: "owner" });

    expect(code).toBe(0);
    expect(out.join("")).toMatch(/^36 gates, 88 Morning items, 145 tasks, 19 broker items/);
  });

  it("emits OwnerItem[] as JSON with --json", async () => {
    const { out, io } = capture();

    await runNeeds(io, await sources10_05(), { json: true }, { caller: "owner" });

    const items: unknown[] = JSON.parse(out.join(""));
    expect(items).toHaveLength(283);
    for (const item of items) expect(() => ownerItemSchema.parse(item)).not.toThrow();
  });

  it("exits unavailable when a source cannot be read, still printing the rest", async () => {
    const { out, err, io } = capture();

    const code = await runNeeds(io, [...(await sources10_05()).slice(1), failingSource("agent-chat", "down")], { json: true }, { caller: "owner" });

    expect(code).toBe(69);
    expect(err.join("")).toBe("agent-chat: down\n");
    expect(JSON.parse(out.join(""))).toHaveLength(264);
  });
});

describe("needs --json in a shell (TP-5556)", () => {
  const ids = async (env: NodeJS.ProcessEnv): Promise<string[]> => {
    const { out, io } = capture();
    const tasks = [decisionTaskItem(withheldTask, false), decisionTaskItem(shownTask, false)];
    await runNeeds(io, await sources10_05(tasks), { json: true }, shellNeedsView(env));
    return z.array(z.object({ id: z.string() })).parse(JSON.parse(out.join(""))).map((item) => item.id);
  };

  it("omits a withheld initiative's ask when CLAUDECODE is set and keeps it in a clean env", async () => {
    const daemon = await needsDaemon();
    try {
      const agent = await ids({ AW_PORT: String(daemon.port), CLAUDECODE: "1" });
      const owner = await ids({ AW_PORT: String(daemon.port) });

      expect(agent).not.toContain("task:PP-7");
      expect(agent).toContain("task:AL-1");
      expect(owner).toContain("task:PP-7");
    } finally {
      await daemon.close();
    }
  });
});
