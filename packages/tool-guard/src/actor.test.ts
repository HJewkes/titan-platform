import { describe, expect, it } from "vitest";
import { AGENT_CANDIDATES, BYPASS_VAR, observeActor } from "./actor.js";

describe("observeActor", () => {
  it("keeps every agent class as a candidate when an agent-chat marker is set", () => {
    const actor = observeActor({ AGENT_CHAT_AGENT_ID: "impl-7", AGENT_CHAT_PROFILE: "worker" }, "sess-1");

    expect(actor).toEqual({ candidates: AGENT_CANDIDATES, id: "impl-7", bypass: false });
  });

  it("falls back to the session id, then to unknown", () => {
    expect(observeActor({}, "sess-1").id).toBe("sess-1");
    expect(observeActor({ AGENT_CHAT_AGENT_ID: "" }, null).id).toBe("unknown");
  });

  it("acts as the owner at a terminal only when the bypass variable is exactly 1", () => {
    expect(observeActor({ [BYPASS_VAR]: "1" }, null)).toMatchObject({ candidates: ["owner-terminal"], bypass: true });
    expect(observeActor({ [BYPASS_VAR]: "true" }, null)).toMatchObject({ candidates: AGENT_CANDIDATES, bypass: false });
  });

  it("never offers an owner class without the bypass", () => {
    const actor = observeActor({ CLAUDECODE: "1" }, "sess-1");

    expect(actor.candidates).not.toContain("owner-terminal");
    expect(actor.candidates).not.toContain("owner-remote");
  });
});
