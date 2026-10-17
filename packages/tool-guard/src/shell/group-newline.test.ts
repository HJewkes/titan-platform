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
  readHead: (dir) => (dir === REPO || dir === `${REPO}/pkg` ? "main" : null),
  readScript: () => null,
};

async function verdict(command: string): Promise<"deny" | "pass"> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const { stdout } = await handle(event, { PATH: "/usr/bin" }, port);
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

/** Each echo ends its text with a newline, so the push the group prints is a line of its own (TP-3332). */
const JOINED = [
  `{ echo hi; echo ${PUSH}; } | bash`,
  `( echo cd .; echo ${PUSH} ) | sh`,
  `{ echo hi && echo ${PUSH}; } | bash`,
  `bash < <(echo hi; echo ${PUSH})`,
  `{ echo hi; echo ${PUSH}; } | cat | bash`,
  `{ echo hi; echo {fd}</dev/null ${PUSH}; } | bash`,
];

/** Text printed with no newline runs on into the next piece's, so the pieces join into the push. */
const RUN_ON = [
  `{ echo -n 'git pu'; echo sh origin HEAD:main; } | bash`,
  `{ printf 'git pu'; echo sh origin HEAD:main; } | bash`,
  `{ printf '%s' 'git pu'; printf '%s\\n' 'sh origin HEAD:main'; } | bash`,
  `{ echo -e 'git pu\\c'; echo sh origin HEAD:main; } | bash`,
  `{ echo 'git pu\\c'; echo sh origin HEAD:main; } | zsh`,
  `{ echo -e -E 'git pu\\c'; echo sh origin HEAD:main; } | bash`,
];

/** bash reads a `{name}` redirect after `}` or `)` as the group's own, so the group still pipes what it prints (TP-3334). */
const NAMED_AFTER_CLOSE = [
  `{ echo ${PUSH}; } {fd}</dev/null | bash`,
  `{ echo {fd}</dev/null ${PUSH}; } {g}</dev/null | bash`,
  `( echo ${PUSH} ) {g}</dev/null | sh`,
  `{ echo ${PUSH}; } {fd}>/dev/null | bash`,
];

describe("a group's printed pieces join as the shell prints them (TP-3332, TP-3334)", () => {
  it.each([...JOINED, ...RUN_ON, ...NAMED_AFTER_CLOSE])("denies %s", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each([
    "{ echo a; echo b; } | sort",
    "( cd pkg && make ) | tee log",
    'while read -r f; do echo "$f"; done < <(git ls-files)',
    "{ git status; git log -1; } | cat",
    "{ echo a; } {fd}</dev/null | cat",
    "{ echo hi; } {fd}</dev/null | cat",
    "exec {fd}</dev/null; cat <&$fd",
    "diff <(echo a) <(echo b)",
    'echo "$(git rev-parse HEAD)"',
    "{ echo hi; echo ls; } | bash",
    "{ echo -n 'git '; echo status; } | bash",
    "bash < <(echo hi; echo ls)",
    "{ echo hi; } {fd}</dev/null | bash",
  ])("allows %s", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });

  it("joins each shell's pieces apart, so echoes the shells print differently do not multiply past the text cap", async () => {
    expect(await verdict(`{ ${"echo 'a\\tb'; ".repeat(6)}} | cat`)).toBe("pass");
    expect(await verdict(`{ ${"echo a; ".repeat(40)}} | bash`)).toBe("pass");
  });
});

const has = (shell: string): boolean => spawnSync(shell, ["-c", "true"]).status === 0;

/** Runs `line` under `runner` in a scratch dir with a fake `git` first on PATH, and reports whether it was asked to push. */
function runsPush(line: string, runner: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "group-newline-"));
  try {
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "git"), `#!/bin/sh\n[ "$*" = "push origin HEAD:main" ] && touch '${path.join(dir, "mk")}'\n`, { mode: 0o755 });
    const [program = "bash", ...flags] = runner.split(" ");
    const env = { ...process.env, ZDOTDIR: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}` };
    spawnSync(program, [...flags, "-c", line], { cwd: dir, env, stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
    return fs.existsSync(path.join(dir, "mk"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Each denied line under a parent shell that runs the push; dash has no `<(` and errors on a word after `}`. */
const PREMISES: Array<[string, string]> = [
  ...JOINED.map((line): [string, string] => [line, "bash"]),
  ...JOINED.filter((line) => !line.includes("<(") && !line.includes("{fd}")).map((line): [string, string] => [line, "dash"]),
  ...JOINED.map((line): [string, string] => [line, "zsh -f"]),
  ...RUN_ON.slice(0, 4).map((line): [string, string] => [line, "bash"]),
  ...RUN_ON.slice(4).map((line): [string, string] => [line, "zsh -f"]),
  ...NAMED_AFTER_CLOSE.map((line): [string, string] => [line, "bash"]),
];

describe.skipIf(!["bash", "zsh", "dash"].every(has))("bash, zsh and dash run the push the denied lines print (TP-3332, TP-3334)", () => {
  it.each(PREMISES)("%s runs the push under %s", (line, runner) => {
    expect(runsPush(line, runner)).toBe(true);
  });

  it.each(["{ echo hi; echo ls; } | bash", "{ echo -n 'git '; echo status; } | bash", "{ echo hi; } {fd}</dev/null | bash"])("%s runs no push under any of them", (line) => {
    expect(["bash", "zsh -f", "dash"].map((runner) => runsPush(line, runner))).toEqual([false, false, false]);
  });
});
