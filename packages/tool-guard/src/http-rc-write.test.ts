import { describe, expect, it } from "vitest";
import type { ActorObservation } from "./actor.js";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";

const emptyFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};

/** Narrows the hook's agent candidates to a worker, so the deny names the worker's own row. */
const workerPort: HookPort = {
  context: nodeContext(HOME, emptyFs),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => (actions, actor: ActorObservation) => decide(actions, { ...actor, candidates: ["worker"] }),
};

function event(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({ tool_name: toolName, session_id: "sess-1", tool_use_id: "tu-1", cwd: REPO, tool_input: toolInput });
}

function deniedRow(log: readonly string[]): string[] {
  return (log[0] ?? "").split("\t").slice(1, 5);
}

describe("handle: a worker writing an http client rc file", () => {
  it("denies a Write to ~/.curlrc under CFG-WK", async () => {
    const { stdout, log } = await handle(event("Write", { file_path: `${HOME}/.curlrc`, content: "request = PUT\n" }), {}, workerPort);

    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(deniedRow(log)).toEqual(["deny", "CFG-WK", "authority-config", "write.config"]);
  });

  it("denies a later Bash copy into ~/.wgetrc", async () => {
    const { stdout, log } = await handle(event("Bash", { command: "cp /tmp/rc ~/.wgetrc" }), {}, workerPort);

    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(deniedRow(log)).toEqual(["deny", "CFG-WK", "authority-config", "bash.config.cp-mv-ln"]);
  });
});
