import type { AgentRow } from "@titan-design/agent-dispatch";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@titan-design/agent-dispatch", async (original) => ({ ...(await original<object>()), dispatchToAgentChat: dispatch }));

const { agentChatAgents } = await import("./agents.js");
const { fixersOver } = await import("./main-red.js");
const { FACTORY_IMPLEMENTER_PROFILE, implementersOver } = await import("./wake.js");

const spawned: { name: string; profile: string }[] = [];
const recorder = {
  roster: async (): Promise<readonly AgentRow[]> => [],
  spawn: async ({ name, profile }: { name: string; profile: string }) => void spawned.push({ name, profile }),
  resume: async () => undefined,
  message: async () => undefined,
};

beforeEach(() => {
  spawned.length = 0;
  dispatch.mockClear();
});

describe("the profile Shepherd's implementer-class agents spawn under", () => {
  it("is the headless bd-implementer, not the builtin that opens a pane", () => {
    expect(FACTORY_IMPLEMENTER_PROFILE).toBe("bd-implementer");
  });

  it("starts a main-red fixer under it", async () => {
    await fixersOver(recorder).spawn("fix-demo-aaaaaaa", "brief", "/srv/demo");
    expect(spawned).toEqual([{ name: "fix-demo-aaaaaaa", profile: "bd-implementer" }]);
  });

  it("starts a wake successor under it", async () => {
    await implementersOver(recorder).spawn("impl-demo-2", "brief", "/srv/demo");
    expect(spawned).toEqual([{ name: "impl-demo-2", profile: "bd-implementer" }]);
  });

  it("forwards it to the dispatch both as the profile and as the allowlist", async () => {
    await agentChatAgents("/bin/agent-chat", { roster: { rows: async () => [], invalidate: () => undefined } as never }).spawn({ name: "n", profile: "bd-implementer", brief: "b", cwd: "/c" });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ profile: "bd-implementer" }), expect.any(Number), ["bd-implementer"]);
  });
});
