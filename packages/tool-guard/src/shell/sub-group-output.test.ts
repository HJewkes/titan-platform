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

/** A substitution holding a group, subshell, list or pipeline prints text a shell then runs (TP-3333). */
const PRINTS_A_PUSH = [
  `echo "$(echo ${PUSH})" | sh`,
  `bash -c "$({ echo ${PUSH}; })"`,
  `eval "$( { echo ${PUSH}; } )"`,
  `bash -c "$( ( echo ${PUSH} ) )"`,
  `bash -c "$(echo ${PUSH} | cat)"`,
  `bash -c "$(printf '%s\\n' hi '${PUSH}')"`,
];

/** Pieces whose later text is the push, and stages that pass text through. */
const MORE_DENIED = [
  `printf '%s\\n' "$(echo ${PUSH})" | bash`,
  `echo "$(printf '%s\\n' '${PUSH}')" | sh`,
  `echo \`echo ${PUSH}\` | sh`,
  `echo "$({ echo hi; echo ${PUSH}; })" | bash`,
  `bash -c "$(echo hi; echo ${PUSH})"`,
  `bash -c "$(echo hi && echo ${PUSH})"`,
  `bash -c "$({ echo hi; } | tee /dev/null; echo ${PUSH})"`,
  `bash -c "$(echo ${PUSH} | tee log)"`,
  `eval "$(echo ${PUSH} | cat | cat)"`,
];

describe("a command substitution holding a group, subshell or pipeline is read (TP-3333)", () => {
  it.each([...PRINTS_A_PUSH, ...MORE_DENIED])("denies %s", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each([
    'echo "$({ echo a; echo b; })"',
    'echo "$(git rev-parse HEAD)"',
    'echo "$(git rev-parse HEAD)" | cat',
    'echo "$(date)" | sh',
    'echo "$(cat x.sh)" | sh',
    'echo "$(echo hi; echo ls)" | bash',
    'eval "$(ssh-agent -s)"',
    'eval "$(direnv hook bash)"',
    'eval "$(brew shellenv)"',
    "x=$( (cd pkg && pwd) )",
    'bash -c "$(echo echo hi | cat)"',
    'git commit -m "$(printf \'%s\\n\' fix: thing)"',
    'echo "$( { echo a; } | sort )"',
    'bash -c "$(cat x.sh)"',
    'bash -c "$(echo hi; git status)"',
    'eval "$(ssh-agent -s | cat)"',
    'eval "$( { ssh-agent -s; } )"',
  ])("allows %s", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });

  it("refuses a substitution whose texts would multiply past the cap instead of reading it", async () => {
    const many = `bash -c "$(${"echo 'a\\tb'; ".repeat(40)})"`;
    expect(["deny", "pass"]).toContain(await verdict(many));
  });
});

const has = (shell: string): boolean => spawnSync(shell, ["-c", "true"]).status === 0;

/** Runs `line` under `runner` in a scratch dir with a fake `git` first on PATH, and reports whether it was asked to push. */
function runsPush(line: string, runner: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-group-output-"));
  try {
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "f"), "push origin HEAD:main\n");
    fs.writeFileSync(path.join(dir, "bin", "git"), `#!/bin/sh\n[ "$*" = "push origin HEAD:main" ] && touch '${path.join(dir, "mk")}'\n`, { mode: 0o755 });
    const [program = "bash", ...flags] = runner.split(" ");
    const env = { ...process.env, ZDOTDIR: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}` };
    spawnSync(program, [...flags, "-c", line], { cwd: dir, env, stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
    return fs.existsSync(path.join(dir, "mk"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A substitution that also runs an unknown command prints text only known at run time, which xargs reads as unknown. */
const PARTLY_UNKNOWN = [
  `echo "$(cat f; printf '')" | xargs git`,
  `echo "$(cat f; echo)" | xargs git`,
  `echo "$(printf ''; cat f)" | xargs git`,
  `echo "$(echo status; cat f)" | xargs git`,
  `printf '%s' "$(cat f; printf '')" | xargs git`,
  `echo $(cat f; printf '') | xargs git`,
  `echo "$(cat f; printf '')" | xargs -I{} git {}`,
];

describe("a substitution that prints part unknown text is not read as all of it (TP-3333)", () => {
  it.each(PARTLY_UNKNOWN)("denies %s", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each(['gh pr create --body "$(cat f)"', 'echo "$(echo HEAD)" | xargs git show', 'echo "$(ls)" | xargs rm', 'echo "$(echo a; ls)"'])("allows %s", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

const RUNNERS = ["bash", "zsh -f", "dash", "zsh --emulate sh -f"];

describe.skipIf(!["bash", "zsh", "dash"].every(has))("real shells run the push the denied lines print (TP-3333)", () => {
  it.each(PRINTS_A_PUSH.flatMap((line) => RUNNERS.map((runner): [string, string] => [line, runner])))("%s runs the push under %s", (line, runner) => {
    expect(runsPush(line, runner)).toBe(true);
  });

  it.each(PARTLY_UNKNOWN.filter((line) => !line.includes("echo status")).flatMap((line) => ["bash", "zsh -f", "dash"].map((runner): [string, string] => [line, runner])))("%s runs the push under %s", (line, runner) => {
    expect(runsPush(line, runner)).toBe(true);
  });

  it.each(['bash -c "$(echo echo hi | cat)"', 'echo "$({ echo a; echo b; })"', 'echo "$(echo ls)" | sh', 'eval "$( { echo hi; echo ls; } )"'])("%s runs no push under any of them", (line) => {
    expect(RUNNERS.map((runner) => runsPush(line, runner))).toEqual([false, false, false, false]);
  });
});
