import { describe, expect, it } from "vitest";
import { AGENT_CANDIDATES, observeActor } from "./actor.js";

describe("observeActor", () => {
  it("keeps every agent class as a candidate when an agent-chat marker is set", () => {
    const actor = observeActor({ AGENT_CHAT_AGENT_ID: "impl-7", AGENT_CHAT_PROFILE: "worker" }, "sess-1");

    expect(actor).toEqual({ candidates: AGENT_CANDIDATES, id: "impl-7" });
  });

  it("falls back to the session id, then to unknown", () => {
    expect(observeActor({}, "sess-1").id).toBe("sess-1");
    expect(observeActor({ AGENT_CHAT_AGENT_ID: "" }, null).id).toBe("unknown");
  });

  it("never offers an owner class, even with the retired bypass variable in the hook's own env", () => {
    const actor = observeActor({ TITAN_TOOL_GUARD_BYPASS: "1", CLAUDECODE: "1" }, "sess-1");

    expect(actor.candidates).toEqual(AGENT_CANDIDATES);
  });
});
