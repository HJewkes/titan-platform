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

/** A substitution holding a group, subshell, list or pipeline prints text that `eval` or `-c` then runs (TP-3333). */
const PRINTS_A_PUSH = [
  `bash -c "$({ echo ${PUSH}; })"`,
  `eval "$( { echo ${PUSH}; } )"`,
  `bash -c "$( ( echo ${PUSH} ) )"`,
  `bash -c "$(echo ${PUSH} | cat)"`,
  `bash -c "$(printf '%s\\n' hi '${PUSH}')"`,
  `sh -c "$(echo hi; echo ${PUSH})"`,
  `zsh -c "$( { echo hi; } ; echo ${PUSH})"`,
];

/** Pieces whose later text is the push, and stages that pass text through. */
const MORE_DENIED = [
  `bash -c "$(echo hi && echo ${PUSH})"`,
  `bash -c "$({ echo hi; } | tee /dev/null; echo ${PUSH})"`,
  `bash -c "$(echo ${PUSH} | tee log)"`,
  `eval "$(echo ${PUSH} | cat | cat)"`,
  // bash drops a NUL from a substitution's output, so `pu\0sh` runs as `push` there.
  `bash -c "$(printf 'git pu\\0sh origin HEAD:main')"`,
];

describe("eval and -c read a command substitution holding a group, subshell, list or pipeline (TP-3333)", () => {
  it.each([...PRINTS_A_PUSH, ...MORE_DENIED])("denies %s", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each([
    'echo "$({ echo a; echo b; })"',
    'echo "$(git rev-parse HEAD)"',
    'eval "$(ssh-agent -s)"',
    'eval "$(direnv hook bash)"',
    'eval "$( { ssh-agent -s; } )"',
    'bash -c "$(cat x.sh)"',
    'bash -c "$(echo echo hi | cat)"',
    'bash -c "$(echo hi; git status)"',
    "git commit -m \"$(cat <<'EOF'\nfix: thing\nEOF\n)\"",
    'gh pr create --body "$(cat f)"',
  ])("allows %s", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });

  it("refuses a substitution whose texts would multiply past the cap instead of reading it", async () => {
    const many = `bash -c "$(${"echo 'a\\tb'; ".repeat(40)})"`;
    expect(["deny", "pass"]).toContain(await verdict(many));
  });
});

/**
 * A print of a substitution piped on still pipes unknown text, so `xargs` fails closed as on main. Each row is one a
 * strict reading of the piped text let through in an earlier round; TP-3333 b takes the piped route.
 */
const MAIN_DENIES = [
  'echo "$(echo status 01>&2; echo push origin HEAD:main)" | xargs git',
  'echo "$(echo status | cat 0>&2; echo push origin HEAD:main)" | xargs git',
  `echo() { command echo "$@" >&2; }; printf '%s\\n' "$(echo status; printf '%s\\n' push origin HEAD:main)" | xargs git`,
  'echo "$(cat <<<status <f)" | xargs git',
  'echo "$(echo ma)${x-in}" | xargs git push origin',
  'echo "$(echo ma)$((0))" | xargs git push origin',
  'echo "$(echo ma)$[0]" | xargs git push origin',
  'echo "$(echo status >&2; echo push origin HEAD:main)" | xargs git',
  `echo "$(cat f; printf '')" | xargs git`,
  'echo "$(<f)" | xargs git',
  'echo "$(echo {push,} origin HEAD:main)" | xargs git',
  `echo "$(printf 'pu\\0sh origin HEAD:main')" | xargs git`,
  `echo "$(printf '' || printf 'status '; echo push origin HEAD:main)" | xargs git`,
];

describe("lines main denies still deny (TP-3333)", () => {
  it.each(MAIN_DENIES)("denies %s", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });
});

const has = (shell: string): boolean => spawnSync(shell, ["-c", "true"]).status === 0;

/** Runs `line` under `runner` in a scratch dir with a fake `git` first on PATH, and reports whether it was asked to push. */
function runsPush(line: string, runner: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-group-output-"));
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

const RUNNERS = ["bash", "zsh -f", "dash", "zsh --emulate sh -f"];

describe.skipIf(!["bash", "zsh", "dash"].every(has))("real shells run the push the denied lines print (TP-3333)", () => {
  it.each(PRINTS_A_PUSH.flatMap((line) => RUNNERS.map((runner): [string, string] => [line, runner])))("%s runs the push under %s", (line, runner) => {
    expect(runsPush(line, runner)).toBe(true);
  });

  it.each(['bash -c "$(echo echo hi | cat)"', 'echo "$({ echo a; echo b; })"', 'eval "$( { echo hi; echo ls; } )"'])("%s runs no push under any of them", (line) => {
    expect(RUNNERS.map((runner) => runsPush(line, runner))).toEqual([false, false, false, false]);
  });
});
