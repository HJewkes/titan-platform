import { describe, expect, it } from "vitest";
import { AGENT_CANDIDATES, BYPASS_VAR, observeActor } from "./actor.js";
import type { Ancestor } from "./ancestry.js";

const shell = (tty: boolean): Ancestor => ({ claude: false, tty });
const claude = (tty: boolean): Ancestor => ({ claude: true, tty });
const atTerminal = () => [shell(true), claude(true), shell(true)];

describe("observeActor", () => {
  it("keeps every agent class as a candidate when an agent-chat marker is set", () => {
    const actor = observeActor({ AGENT_CHAT_AGENT_ID: "impl-7", AGENT_CHAT_PROFILE: "worker" }, "sess-1", atTerminal);

    expect(actor).toEqual({ candidates: AGENT_CANDIDATES, id: "impl-7", bypass: false });
  });

  it("falls back to the session id, then to unknown", () => {
    expect(observeActor({}, "sess-1", atTerminal).id).toBe("sess-1");
    expect(observeActor({ AGENT_CHAT_AGENT_ID: "" }, null, atTerminal).id).toBe("unknown");
  });

  it("acts as the owner at a terminal only when the bypass variable is exactly 1", () => {
    expect(observeActor({ [BYPASS_VAR]: "1" }, null, atTerminal)).toMatchObject({ candidates: ["owner-terminal"], bypass: true });
    expect(observeActor({ [BYPASS_VAR]: "true" }, null, atTerminal)).toMatchObject({ candidates: AGENT_CANDIDATES, bypass: false });
  });

  it("never offers an owner class without the bypass", () => {
    const actor = observeActor({ CLAUDECODE: "1" }, "sess-1", atTerminal);

    expect(actor.candidates).not.toContain("owner-terminal");
    expect(actor.candidates).not.toContain("owner-remote");
  });

  it("withholds the bypass from a session started by any command an agent ran, however it set the variable", () => {
    const underAgent = () => [shell(false), claude(false), shell(false), claude(true), shell(true)];

    expect(observeActor({ [BYPASS_VAR]: "1" }, null, underAgent)).toMatchObject({ candidates: AGENT_CANDIDATES, bypass: false });
  });

  it("withholds the bypass from a session with no terminal, as one detached from an agent's tree has none", () => {
    expect(observeActor({ [BYPASS_VAR]: "1" }, null, () => [shell(false), claude(false)]).bypass).toBe(false);
  });

  it("withholds the bypass when the process table could not be read", () => {
    expect(observeActor({ [BYPASS_VAR]: "1" }, null, () => []).bypass).toBe(false);
  });

  it("reads the process table only when the bypass variable is set", () => {
    let reads = 0;

    observeActor({}, "sess-1", () => {
      reads += 1;
      return atTerminal();
    });

    expect(reads).toBe(0);
  });
});
