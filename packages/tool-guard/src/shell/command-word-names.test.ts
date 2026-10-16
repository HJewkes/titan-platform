import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifyContext } from "../types.js";
import { canonicalShell } from "./shell-names.js";

const REPO = "/home/you/projects/app";
const PUSH = "git push origin HEAD:main";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: () => null,
};

async function hookStdout(command: string): Promise<string> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  return (await handle(event, { PATH: "/usr/bin" }, port)).stdout;
}

async function verdict(command: string): Promise<"deny" | "pass"> {
  return (await hookStdout(command)).includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

/** The rule a denial names, as `(family.id, rule ID)`. */
async function ruleOf(command: string): Promise<string | undefined> {
  return /\(bash\.[^)]*\)/.exec(await hookStdout(command))?.[0];
}

describe("command words zsh EQUALS or a shell variant name rewrites (TP-3208)", () => {
  it.each([
    ["an EQUALS zsh", `=zsh -c '${PUSH}'`],
    ["an EQUALS bash", `=bash -c '${PUSH}'`],
    ["a versioned zsh", `zsh5 -c '${PUSH}'`],
    ["a versioned zsh by path", `/bin/zsh5 -c '${PUSH}'`],
    ["a restricted zsh", `rzsh -c '${PUSH}'`],
    ["a restricted bash", `rbash -c '${PUSH}'`],
    ["a restricted ksh", `rksh -c '${PUSH}'`],
    ["a dotted bash version", `bash5.2 -c '${PUSH}'`],
    ["an EQUALS versioned zsh", `=zsh5 -c '${PUSH}'`],
    ["an EQUALS wrapper", `=env zsh -c '${PUSH}'`],
  ])("denies a push behind %s", async (_form, line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it("gives an EQUALS git push the rule a bare push gets", async () => {
    const bare = await ruleOf(PUSH);
    expect(bare).toBeDefined();
    expect(await ruleOf(`=${PUSH}`)).toBe(bare);
  });

  it.each(["rsh host ls", "=ls -la", "zsh5 -c 'echo hi'", "rbash -c 'echo hi'"])("allows %s", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });

  it.each([
    ["zsh5", "zsh"],
    ["rzsh", "zsh"],
    ["rbash", "bash"],
    ["rksh", "ksh"],
    ["bash5.2", "bash"],
    ["ksh93", "ksh"],
    ["zsh-5.9", "zsh"],
    ["rsh", "rsh"],
    ["ssh", "ssh"],
    ["bashful", "bashful"],
    ["zsh5x", "zsh5x"],
  ])("reads %s as %s", (name, base) => {
    expect(canonicalShell(name)).toBe(base);
  });
});

const zsh = spawnSync("zsh", ["-f", "-c", "true"]).status === 0;
const zsh5 = fs.existsSync("/bin/zsh5");
const rzsh = spawnSync("rzsh", ["-f", "-c", "true"]).status === 0;

/** Runs `line` as a zsh script in a scratch dir and reports whether it created `mk`. */
function runs(line: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-names-"));
  try {
    fs.writeFileSync(path.join(dir, "s.zsh"), `${line}\n`);
    spawnSync("zsh", ["-f", "s.zsh"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
    return fs.existsSync(path.join(dir, "mk"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!zsh)("zsh runs the text behind each rewritten name (TP-3208)", () => {
  it("runs an EQUALS zsh", () => {
    expect(runs("=zsh -f -c 'touch mk'")).toBe(true);
  });

  it.skipIf(!rzsh)("runs a restricted zsh", () => {
    expect(runs("rzsh -f -c 'touch mk'")).toBe(true);
  });

  it.skipIf(!zsh5)("runs a versioned zsh", () => {
    expect(runs("/bin/zsh5 -f -c 'touch mk'")).toBe(true);
  });
});
