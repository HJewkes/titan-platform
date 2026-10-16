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
const TEXT = `'${PUSH}'`;

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: (file) => (file === `${REPO}/x.sh` ? `${PUSH}\n` : null),
};

async function verdict(command: string): Promise<"deny" | "pass"> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const { stdout } = await handle(event, { PATH: "/usr/bin" }, port);
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

/** Each runs `$TEXT` in the shell it names; the block below runs every form that runs on this host. */
const PUSH_ROUTES = [
  ["zsh's --emulate taking its mode", `zsh --emulate sh -c ${TEXT}`],
  ["zsh's --emulate by path", `/usr/bin/zsh --emulate ksh -c ${TEXT}`],
  ["--emulate before a cluster that takes a name", `zsh --emulate sh -fo errexit -c ${TEXT}`],
  ["a versioned zsh's --emulate", `zsh5 --emulate sh -c ${TEXT}`],
  ["an EQUALS zsh's --emulate", `=zsh --emulate ksh -c ${TEXT}`],
  ["--emulate=sh, which zsh refuses", `zsh --emulate=sh -c ${TEXT}`],
  ["a zsh cluster ending in o", `zsh -xo errexit -c ${TEXT}`],
  ["a zsh -c cluster ending in o", `zsh -co errexit ${TEXT}`],
  ["zsh's O, which takes no value", `zsh -O -c ${TEXT}`],
  ["zsh's o taking the rest of its cluster", `zsh -c -oerrexit ${TEXT}`],
  ["a bash cluster ending in o", `bash -eo pipefail -c ${TEXT}`],
  ["a bash cluster ending in O", `bash -xO extglob -c ${TEXT}`],
  ["a bash -c cluster ending in O", `bash -cO extglob ${TEXT}`],
  ["a bash o before c in one cluster", `bash -oc pipefail ${TEXT}`],
  ["a plus-signed bash cluster", `bash +eO extglob -c ${TEXT}`],
  ["a dash cluster ending in o", `dash -eo errexit -c ${TEXT}`],
  ["a lone dash before the bash -c text", `bash -c - ${TEXT}`],
  ["a lone dash before the zsh -c text", `zsh -c - ${TEXT}`],
  ["a lone dash before the sh -c text", `sh -c - ${TEXT}`],
  ["bash -s, whose operand is $1", `bash -s foo <<< ${TEXT}`],
  ["zsh -s, whose operand is $1", `zsh -s foo <<< ${TEXT}`],
  ["/dev/stdin as the script file", `bash /dev/stdin <<< ${TEXT}`],
  ["/dev/stdin after --", `bash -- /dev/stdin <<< ${TEXT}`],
  ["/dev/stdin after -", `bash - /dev/stdin <<< ${TEXT}`],
  ["a script file after a bash cluster ending in o", "bash -eo pipefail ./x.sh"],
  ["a script file after zsh's --emulate", "zsh --emulate sh ./x.sh"],
] as const;

describe("a shell's options are read as the shell reads them (TP-3221)", () => {
  it.each(PUSH_ROUTES)("denies a push behind %s", async (_form, line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each([
    "zsh --emulate sh -c 'echo hi'",
    "bash -eo pipefail -c 'echo hi'",
    "zsh -O -c 'echo hi'",
    "bash -s foo <<< 'echo hi'",
    `bash -- foo <<< ${TEXT}`,
  ])("allows %s", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

const has = (shell: string): boolean => spawnSync(shell, ["-c", "true"]).status === 0;
const SHELLS_HERE = new Set(["bash", "zsh", "zsh5", "dash", "sh"].filter(has));

/** Runs `line` under bash in a scratch dir, with zsh reading no startup files, and reports whether it created `mk`. */
function runs(line: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-options-"));
  try {
    fs.writeFileSync(path.join(dir, "s.sh"), `${line}\n`);
    spawnSync("bash", ["s.sh"], { cwd: dir, env: { ...process.env, ZDOTDIR: dir }, stdio: ["ignore", "ignore", "ignore"] });
    return fs.existsSync(path.join(dir, "mk"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!SHELLS_HERE.has("bash"))("each shell runs the text behind its options (TP-3221)", () => {
  it.each(
    PUSH_ROUTES.filter(([, line]) => !line.includes("x.sh") && !line.includes("--emulate=") && !line.startsWith("="))
      .map(([form, line]) => [form, line.replaceAll(TEXT, "'touch mk'").replace("/usr/bin/zsh", "zsh")] as const),
  )("runs the text behind %s", (_form, line) => {
    const shell = line.split(" ")[0] ?? "";
    if (!SHELLS_HERE.has(shell)) return;
    expect(runs(line)).toBe(true);
  });

  it.skipIf(!SHELLS_HERE.has("zsh"))("runs the text behind an EQUALS zsh's --emulate, under zsh", () => {
    expect(runs("zsh -f -c \"=zsh --emulate ksh -c 'touch mk'\"")).toBe(true);
  });

  it("runs nothing behind --emulate=sh, so its denial only over-reads", () => {
    expect(runs("zsh --emulate=sh -c 'touch mk'")).toBe(false);
  });
});
