import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";
const PUSH = "git push origin HEAD:main";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: () => null,
};

async function verdict(command: string): Promise<"deny" | "pass"> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const { stdout } = await handle(event, { PATH: "/usr/bin" }, port);
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

/** Each runs its last word as zsh code; the zsh block below proves the forms zsh accepts. */
const PUSH_ROUTES = [
  ["a zsh mode", `emulate zsh -c '${PUSH}'`],
  ["a reset sh mode", `emulate -R sh -c '${PUSH}'`],
  ["an option value before -c", `emulate sh -o x -c '${PUSH}'`],
  ["a real option before -c", `emulate sh -o errexit -c '${PUSH}'`],
  ["a plus-signed c", `emulate sh +c '${PUSH}'`],
  ["c inside a flag cluster", `emulate sh -xc '${PUSH}'`],
  ["a cluster that takes an option name", `emulate sh -co errexit '${PUSH}'`],
  ["a lone dash between -c and the text", `emulate sh -c - '${PUSH}'`],
  ["a dynamic word that may be -c", `emulate sh $f '${PUSH}'`],
  ["the builtin prefix", `builtin emulate zsh -c '${PUSH}'`],
  ["a dynamic word after a wrapper, an over-read since nohup runs no builtin", `nohup $X emulate zsh -c '${PUSH}'`],
] as const;

describe("emulate -c text is walked as eval (TP-3207)", () => {
  it.each(PUSH_ROUTES)("denies a push behind %s", async (_form, line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each([
    ["a variable holding the push", `s='${PUSH}'; `],
    ["an unknown variable", ""],
  ])('gives emulate zsh -c "$s" the verdict of eval "$s" for %s', async (_form, prefix) => {
    expect(await verdict(`${prefix}emulate zsh -c "$s"`)).toBe(await verdict(`${prefix}eval "$s"`));
  });

  it.each(["emulate -L zsh", "emulate zsh -c 'echo hi'", "emulate", "emulate -LR sh", "emulate sh -o errexit"])("allows %s", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

const zsh = spawnSync("zsh", ["-f", "-c", "true"]).status === 0;

describe.skipIf(!zsh)("zsh runs the text of each emulate form (TP-3207)", () => {
  function runs(line: string): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emulate-c-"));
    try {
      fs.writeFileSync(path.join(dir, "s.zsh"), `${line}\n`);
      spawnSync("zsh", ["-f", "s.zsh"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
      return fs.existsSync(path.join(dir, "mk"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([
    "emulate zsh -c 'touch mk'",
    "emulate -R sh -c 'touch mk'",
    "emulate sh -o errexit -c 'touch mk'",
    "emulate sh +c 'touch mk'",
    "emulate sh -xc 'touch mk'",
    "emulate sh -co errexit 'touch mk'",
    "emulate sh -c - 'touch mk'",
    "f=-c; emulate sh $f 'touch mk'",
  ])("runs %s", (line) => {
    expect(runs(line)).toBe(true);
  });
});
