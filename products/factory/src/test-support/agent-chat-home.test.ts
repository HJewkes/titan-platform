import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInstalledHeadless, installedProfilesDir } from "@titan-design/agent-dispatch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolateAgentChatHome } from "./agent-chat-home.js";

let dir: string;
let host: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "titan-agent-chat-home-"));
  host = join(dir, "host");
  mkdirSync(join(host, "profiles"), { recursive: true });
  writeFileSync(join(host, "profiles", "rv-readonly.json"), JSON.stringify({ surface: "interactive" }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("a test that isolates the agent-chat home", () => {
  it("reads its own headless profiles when the host exports AGENT_CHAT_HOME", () => {
    vi.stubEnv("AGENT_CHAT_HOME", host);
    const home = join(dir, "home");

    const profilesDir = isolateAgentChatHome(home, ["rv-readonly", "bd-implementer"]);

    expect(installedProfilesDir()).toBe(join(home, ".agent-chat", "profiles"));
    expect(profilesDir).toBe(installedProfilesDir());
    expect(() => assertInstalledHeadless("rv-readonly")).not.toThrow();
    expect(() => assertInstalledHeadless("bd-implementer")).not.toThrow();
  });

  it("reads its own profiles when the host leaves AGENT_CHAT_HOME unset, and HOME is the test's", () => {
    vi.stubEnv("AGENT_CHAT_HOME", undefined);
    const home = join(dir, "home");

    isolateAgentChatHome(home, ["rv"]);

    expect(process.env.HOME).toBe(home);
    expect(() => assertInstalledHeadless("rv")).not.toThrow();
  });

  it("installs no profile it was not given", () => {
    isolateAgentChatHome(join(dir, "home"), ["rv"]);

    expect(() => assertInstalledHeadless("rv-readonly")).toThrow(/unreadable/);
  });
});
