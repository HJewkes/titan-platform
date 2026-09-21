import { describe, expect, it } from "vitest";
import { classifySession } from "./classify-session.js";

describe("classifySession", () => {
  it("classifies a depth-1 origin as agent_spawned even when start_type is sdk-cli", () => {
    const result = classifySession({
      startType: "sdk-cli",
      origin: { depth: 1, parentName: "cc-longhorizon", profile: "implementer" },
    });

    expect(result.sessionClass).toBe("agent_spawned");
    expect(result.humanRole).toBeNull();
  });

  it("classifies sdk-cli with no origin as headless_sdk", () => {
    expect(classifySession({ startType: "sdk-cli" }).sessionClass).toBe("headless_sdk");
  });

  it("splits human sessions into coordinator and adhoc", () => {
    const base = { startType: "cli" };

    expect(classifySession({ ...base, inboundKinds: ["channel_message"] })).toMatchObject({
      sessionClass: "human_interactive",
      humanRole: "coordinator",
    });
    expect(classifySession({ ...base, signalKinds: ["agent_spawn"] }).humanRole).toBe("coordinator");
    expect(classifySession({ ...base, signalKinds: ["chat_send"] }).humanRole).toBe("coordinator");
    expect(classifySession({ ...base, signalKinds: ["commit"], inboundKinds: ["human_typed"] }).humanRole).toBe("adhoc");
  });

  it("treats a depth-0 origin as the human's own pane", () => {
    expect(classifySession({ origin: { depth: 0, parentName: "human", profile: "coordinator" } }).sessionClass).toBe("human_interactive");
    expect(classifySession({ origin: { depth: 0, originKind: "adopted", profile: "coordinator" } }).sessionClass).toBe("human_interactive");
    expect(classifySession({ origin: { depth: 0, originKind: "inherited", profile: "coordinator" } }).sessionClass).toBe("human_interactive");
    expect(classifySession({ origin: { depth: 0, parentName: "cc-longhorizon", profile: null } }).sessionClass).toBe("human_interactive");
  });

  it("classifies a depth-0 origin with a worker profile and an agent parent as agent_spawned", () => {
    const origin = { depth: 0, parentName: "cc-longhorizon", originKind: "spawned", profile: "implementer" };

    expect(classifySession({ origin }).sessionClass).toBe("agent_spawned");
  });

  it("classifies a structured content-block prompt with few human turns as other_headless", () => {
    const facts = { startType: "cli", firstUserText: '[{"type":"text","text":"run"}]', humanTurnCount: 1 };

    expect(classifySession(facts).sessionClass).toBe("other_headless");
    expect(classifySession({ ...facts, humanTurnCount: 9 }).sessionClass).toBe("human_interactive");
  });

  it("falls back to human_interactive with no origin and no headless marker", () => {
    expect(classifySession({ startType: "cli", firstUserText: "fix the flaky test" })).toMatchObject({
      sessionClass: "human_interactive",
      humanRole: "adhoc",
    });
  });
});
