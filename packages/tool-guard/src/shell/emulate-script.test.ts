import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";

const HOME = "/home/you";
const PUSH = "git push origin HEAD:main";

const port: HookPort = {
  context: nodeContext(HOME, { realpath: (p) => p, readHead: () => "feat", isFile: () => false }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

const input = (command: string) => JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });

async function handled(command: string): Promise<"deny" | "pass"> {
  const { stdout } = await handle(input(command), {}, port);
  return stdout === "" ? "pass" : "deny";
}

describe("emulate -c TEXT runs its text like eval (TP-3207)", () => {
  it.each([
    ["a mode", `emulate zsh -c '${PUSH}'`],
    ["-R and a mode", `emulate -R sh -c '${PUSH}'`],
    ["an option with a value before -c", `emulate sh -o x -c '${PUSH}'`],
    ["a plus option before the mode", `emulate +o x -L zsh -c '${PUSH}'`],
    ["no mode", `emulate -c '${PUSH}'`],
  ])("denies a push behind %s", async (_name, line) => {
    expect(await handled(line)).toBe("deny");
  });

  it.each([
    ["a push in a variable", `s='${PUSH}'; `],
    ["a plain command in a variable", "s='echo hi'; "],
    ["an unset variable", ""],
  ])("gives emulate zsh -c \"$s\" the verdict of eval \"$s\" for %s", async (_name, setup) => {
    expect(await handled(`${setup}emulate zsh -c "$s"`)).toBe(await handled(`${setup}eval "$s"`));
  });

  it.each(["emulate -L zsh", "emulate zsh -c 'echo hi'", "emulate", "emulate -R zsh"])("allows %s", async (line) => {
    expect(await handled(line)).toBe("pass");
  });
});

const zsh = spawnSync("zsh", ["-f", "-c", "true"]).status === 0;

describe.skipIf(!zsh)("zsh really runs the emulate -c text (TP-3207)", () => {
  it("creates the marker file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emulate-c-"));
    try {
      spawnSync("zsh", ["-f", "-c", "emulate zsh -c 'touch mk'"], { cwd: dir, stdio: "ignore" });
      expect(fs.existsSync(path.join(dir, "mk"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
