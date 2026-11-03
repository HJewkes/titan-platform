import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifyContext } from "../types.js";
import { shellOracle } from "../test-support/shell-rows.js";

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

/** Each `}` of a run closes one group, so the outer group's text reaches the pipe (TP-3349). */
const CLOSE_RUNS = [
  `{ { echo ${PUSH}; } } | bash`,
  `{ echo hi; { echo ${PUSH}; } } | bash`,
  `{ { { echo ${PUSH}; } } } | sh`,
  `{ { echo ${PUSH}; } } | cat | bash`,
  `{ { echo hi; } ; { echo ${PUSH}; } } | bash`,
  `{ echo ${PUSH}; { echo hi; } } | bash`,
];
const NAMED_AFTER_RUN = `{ { echo ${PUSH}; } } {fd}</dev/null | bash`;

describe("a run of closing braces hands the group's printed text on (TP-3349)", () => {
  it.each([...CLOSE_RUNS, NAMED_AFTER_RUN])("denies %s", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each([
    "{ { echo a; } } | sort",
    "{ { git status; } } | cat",
    "{ echo a; { echo b; } } | sort",
    "{ { echo a; } }",
    "echo '} }' | cat",
    '{ echo "}"; } | cat',
    "{ { echo hi; } } | bash",
    `{ { echo ${PUSH}; } '}' } | cat`,
  ])("allows %s", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

const has = (shell: string): boolean => spawnSync(shell, ["-c", "true"]).status === 0;

/** Whether `line` under `runner` asks a fake `git` to push; a describe adds its rows and runs them all through one driver (TP-4453). */
const runsPushOracle = () =>
  shellOracle("group-close-run-", (dir, line: string, runner: string) => {
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "git"), `#!/bin/sh\n[ "$*" = "push origin HEAD:main" ] && touch '${path.join(dir, "mk")}'\n`, { mode: 0o755 });
    const [program = "bash", ...flags] = runner.split(" ");
    return {
      run: { program, args: [...flags, "-c", line], extraEnv: { ZDOTDIR: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}` } },
      read: () => fs.existsSync(path.join(dir, "mk")),
    };
  });

const RUNNERS = ["bash", "zsh -f", "dash", "zsh --emulate sh"];

describe.skipIf(!["bash", "zsh", "dash"].every(has))("the shells run the push a closing-brace run prints (TP-3349)", () => {
  const rows = CLOSE_RUNS.flatMap((line) => RUNNERS.map((runner): [string, string] => [line, runner]));
  const runsPush = runsPushOracle();
  for (const [line, runner] of [...rows, [NAMED_AFTER_RUN, "bash"] as const]) runsPush.add(line, runner);
  runsPush.beforeAll();

  it.each(rows)("%s runs the push under %s", (line, runner) => {
    expect(runsPush.get(line, runner)).toBe(true);
  });

  it(`${NAMED_AFTER_RUN} runs the push under bash`, () => {
    expect(runsPush.get(NAMED_AFTER_RUN, "bash")).toBe(true);
  });
});
