import { ownerItemSchema } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import { decisionTask } from "../test-support/owner-queue-10-05.js";
import { createActiveWorkSource } from "./active-work-source.js";

const ORIGIN = "http://127.0.0.1:7400";

function daemon(humanOnly: string[], known = true) {
  const calls: { url: string; body: unknown }[] = [];
  const tasks = [decisionTask(1), { ...decisionTask(2), slug: "home" }];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const inventory = { initiatives: ["demo", "home"].map((slug) => ({ slug, human_only: humanOnly.includes(slug) })), human_only_known: known };
    const data = String(url).endsWith("/task.list") ? { tasks } : inventory;
    return new Response(JSON.stringify({ ok: true, data }));
  };
  return { fetch, calls };
}

describe("createActiveWorkSource", () => {
  it("asks the daemon for open needs-decision tasks across every initiative", async () => {
    const { fetch, calls } = daemon([]);

    await createActiveWorkSource({ origin: ORIGIN, fetch }).open();

    expect(calls).toContainEqual({ url: `${ORIGIN}/rpc/task.list`, body: { all_initiatives: true, status: "open", tag: "needs-decision" } });
  });

  it("leaves out a personal initiative's tasks", async () => {
    const { fetch } = daemon(["home"]);

    const items = await createActiveWorkSource({ origin: ORIGIN, fetch }).open();

    expect(items.map((item) => item.sources[0])).toEqual([{ system: "active-work", ref: "demo/D-1001" }]);
    expect(items.every((item) => ownerItemSchema.safeParse(item).success)).toBe(true);
  });

  it("keeps a personal initiative's tasks, marked personal, when asked", async () => {
    const { fetch } = daemon(["home"]);

    const items = await createActiveWorkSource({ origin: ORIGIN, fetch, includePersonal: true }).open();

    expect(items.map((item) => [item.id, item.personal])).toEqual([
      ["task:D-1001", false],
      ["task:D-1002", true],
    ]);
  });

  it("treats every initiative as personal when the charter is unreadable", async () => {
    const { fetch } = daemon([], false);

    expect(await createActiveWorkSource({ origin: ORIGIN, fetch }).open()).toEqual([]);
  });
});
