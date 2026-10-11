import { describe, expect, it } from "vitest";
import { BYPASS_VAR } from "../actor.js";
import { nodeContext } from "../context.js";
import type { ReadFs } from "../context.js";
import { classify } from "../classify.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";

const HOME = "/home/you";
const noFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};
const port: HookPort = { context: nodeContext(HOME, noFs), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

async function decisionFor(command: string, env: Record<string, string> = {}): Promise<"deny" | "pass"> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });
  const result = await handle(input, env, port);
  return result.stdout.includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

const settingTheBypass = [
  "TITAN_TOOL_GUARD_BYPASS=1 claude -p hi",
  "export TITAN_TOOL_GUARD_BYPASS=1; claude",
  "env TITAN_TOOL_GUARD_BYPASS=1 claude",
  "set -a; TITAN_TOOL_GUARD_BYPASS=1; claude",
  "TITAN_TOOL_GUARD_BYPASS=$(echo 1) claude",
  "declare -x TITAN_TOOL_GUARD_BYPASS=1",
  "readonly TITAN_TOOL_GUARD_BYPASS=1",
  "v=TITAN_TOOL_GUARD_BYPASS; export $v=1",
  "export TITAN_TOOL_GUARD_BYPAS$'S'=1",
  "N=$(printf TITAN_TOOL_GUARD_BYPASS); env $N=1 claude",
  "env $(printf TITAN_TOOL_GUARD_BYPASS)=1 claude",
  "export $(printf TITAN_TOOL_GUARD_BYPASS)=1; claude",
  'export "$(printf TITAN_TOOL_GUARD_BYPASS)=1"; claude',
  "declare -n r=TITAN_TOOL_GUARD_BYPASS; export r=1; claude",
  "set -a; printf -v TITAN_TOOL_GUARD_BYPASS 1; claude",
  "set -a; read TITAN_TOOL_GUARD_BYPASS <<< 1; claude",
  "set -a; mapfile TITAN_TOOL_GUARD_BYPASS <<< 1; claude",
  "bash -c 'export TITAN_TOOL_GUARD_BYPASS=1; claude'",
];

function spellingsOf(command: string): string[] {
  const ctx = { home: HOME, readLink: () => null, readHead: () => null, readScript: () => null };
  return classify({ kind: "bash", command, cwd: `${HOME}/app`, toolName: "Bash", sessionId: null, toolUseId: null }, ctx).map((a) => a.spelling);
}

describe("an agent setting the tool-guard bypass variable", () => {
  it.each(settingTheBypass)("is denied: %s", async (command) => {
    expect(await decisionFor(command)).toBe("deny");
  });

  it.each(settingTheBypass)("is classified bash.config.bypass-env: %s", (command) => {
    expect(spellingsOf(command)).toContain("bash.config.bypass-env");
  });

  it.each(settingTheBypass)("passes in an owner session: %s", async (command) => {
    expect(await decisionFor(command, { [BYPASS_VAR]: "1" })).toBe("pass");
  });

  it.each([
    "echo $TITAN_TOOL_GUARD_BYPASS",
    "unset TITAN_TOOL_GUARD_BYPASS",
    "grep TITAN_TOOL_GUARD_BYPASS src/actor.ts",
    'export PATH="$PATH:/x"',
    "FOO=1 claude -p hi",
    "env FOO=1 claude -p hi",
    "read -r line <<< x",
    "printf '%s\\n' hi",
    "echo --flag=$x",
  ])("passes when it only reads or leaves the variable alone: %s", async (command) => {
    expect(await decisionFor(command)).toBe("pass");
  });
});
