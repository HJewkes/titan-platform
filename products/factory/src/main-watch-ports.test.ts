import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configuredMainWatch } from "./main-watch-ports.js";

const dirs: string[] = [];
afterEach(() => void dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** An environment whose titan-factory config holds `shepherd`. */
function envWith(shepherd: Record<string, unknown>): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "main-watch-ports-"));
  dirs.push(home);
  mkdirSync(join(home, "titan-factory"));
  writeFileSync(join(home, "titan-factory", "config.json"), JSON.stringify({ shepherd: { agentChatBin: "/opt/agent-chat/bin/agent-chat", ...shepherd } }));
  return { XDG_CONFIG_HOME: home };
}

/** An `agent-chat` whose `agent ls --json` prints one row per name, with that presence. */
function fakeAgentChat(presences: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "main-watch-ports-bin-"));
  dirs.push(dir);
  const rows = Object.entries(presences).map(([name, presence], index) => ({ name, agentId: `a${index}`, state: "live", presence, status: "running", profile: "p", surface: "headless", cwd: "/", sessionId: `s${index}`, generation: 1 }));
  const bin = join(dir, "agent-chat");
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(rows))});\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("the main watch's live names", () => {
  it("counts only a seat a connected session holds, as the send can reach no other", async () => {
    const bin = fakeAgentChat({ "live-coord": "live", "detached-coord": "detached", "exited-coord": "exited" });
    const ports = configuredMainWatch(envWith({ agentChatBin: bin }));

    expect([...((await ports?.liveNames?.()) ?? [])]).toEqual(["live-coord"]);
  });
});

describe("shepherd.redSeat", () => {
  it("routes a repo's red events to its entry, whatever the case of the key or the repo", () => {
    const ports = configuredMainWatch(envWith({ hubSeat: "hub-coord", redSeat: { repos: { "Octo/Demo": "factory-coord" } } }));

    expect(ports?.redSeat?.("octo/DEMO")).toBe("factory-coord");
    expect(ports?.redSeat?.("octo/other")).toBeUndefined();
  });

  it("falls back to the global seat when the repo has no entry", () => {
    const ports = configuredMainWatch(envWith({ redSeat: { repos: { "octo/demo": "factory-coord" }, fallback: "red-coord" } }));

    expect(ports?.redSeat?.("octo/demo")).toBe("factory-coord");
    expect(ports?.redSeat?.("octo/other")).toBe("red-coord");
  });

  it("names no red seat without the key, so the run's seat and the hub seat route as before", () => {
    const ports = configuredMainWatch(envWith({ hubSeat: "hub-coord" }));

    expect(ports?.redSeat?.("octo/demo")).toBeUndefined();
    expect(ports?.hubSeat()).toBe("hub-coord");
  });
});
