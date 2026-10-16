import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifyContext } from "../types.js";
import { zshRunsValue } from "./zsh-value-flags.js";

const REPO = "/home/you/projects/app";
const PUSH = "git push origin HEAD:feat";
const DENY = '"permissionDecision":"deny"';

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "feat" : null),
  readScript: () => null,
};

async function hookStdout(command: string): Promise<string> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  return (await handle(event, { PATH: "/usr/bin" }, port)).stdout;
}

const runs = (text: string) => zshRunsValue(text, text.indexOf("$"));

describe("zshRunsValue and the prompt flag", () => {
  it.each(["${(%%)x}", "${(%L%)x}", "${(%%%)x}", "${(j:,:%%)x}"])("is true for %s", (text) => {
    expect(runs(text)).toBe(true);
  });

  it.each(["${(%)x}", "${(j:%%:)x}", "${(s.%%.)x}"])("is false for %s", (text) => {
    expect(runs(text)).toBe(false);
  });
});

describe("the hook and the prompt flag", () => {
  it.each(["${(%%)y}", '"${(%%)y}"'])("denies %s before a push", async (form) => {
    expect(await hookStdout(`: ${form}; ${PUSH}`)).toContain(DENY);
  });

  it("allows a single % flag before a push", async () => {
    expect(await hookStdout(`: \${(%)y}; ${PUSH}`)).not.toContain(DENY);
  });
});

const zshOnPath = spawnSync("zsh", ["-c", "exit 0"]).status === 0;

describe.skipIf(!zshOnPath)("zsh under promptsubst", () => {
  function marker(expansion: string): boolean {
    const dir = mkdtempSync(join(tmpdir(), "tool-guard-prompt-"));
    try {
      spawnSync("zsh", ["-fc", `setopt promptsubst; y='$(touch marker)'; : ${expansion}`], { cwd: dir });
      return existsSync(join(dir, "marker"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("runs the value of ${(%%)y}", () => {
    expect(marker("${(%%)y}")).toBe(true);
  });

  it('does not run the value of "${(%)y}"', () => {
    expect(marker('"${(%)y}"')).toBe(false);
  });
});
