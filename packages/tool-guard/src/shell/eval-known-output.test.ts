import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import type { ReadFs } from "../context.js";
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

const PUSH = "git push origin HEAD:main";
const MERGE = "gh pr merge 1 --squash";

/** Lines whose only route to the guarded command is the literal output of a substitution that eval or `-c` runs. */
const reachedThroughOutput = (cmd: string): [string, string][] => [
  ["eval of a cat heredoc, quoted delimiter", `eval "$(cat <<'E'\n${cmd}\nE\n)"`],
  ["eval of a cat heredoc, unquoted delimiter", `eval "$(cat <<E\n${cmd}\nE\n)"`],
  ["eval of a cat here-string", `eval "$(cat <<< '${cmd}')"`],
  ["eval of echo", `eval "$(echo ${cmd})"`],
  ["eval of printf", `eval "$(printf '%s' '${cmd}')"`],
  ["eval of a backquoted echo", `eval "\`echo ${cmd}\`"`],
  ["eval of an unquoted substitution", `eval $(echo ${cmd})`],
  ["eval of command cat over a heredoc", `eval "$(command cat <<'E'\n${cmd}\nE\n)"`],
  ["bash -c of echo", `bash -c "$(echo ${cmd})"`],
  ["sh -c of a cat heredoc", `sh -c "$(cat <<'E'\n${cmd}\nE\n)"`],
  ["the arithmetic form, X holding the command in a subscript", `X='a[$(${cmd})]'; eval "$(cat <<'E'\n$((X))\nE\n)"`],
];

/** Lines where the output lands inside a longer word, which the shell splices together before eval runs it. */
const splicedIntoWord: [string, string][] = [
  ["eval of a word around an echoed subcommand", `eval "git $(echo push) origin HEAD:main"`],
  ["eval of a word after a cat heredoc", `eval "$(cat <<'E'\ngh pr\nE\n) merge 1 --squash"`],
  ["eval of a word after an echoed command name", `eval "$(echo git) push origin HEAD:main"`],
  ["bash -c of a word around a backquoted echo", `bash -c "git \`echo push\` origin HEAD:main"`],
];

const denyRows = [
  ...reachedThroughOutput(PUSH).map(([n, c]) => [`${n} (push)`, c]),
  ...reachedThroughOutput(MERGE).map(([n, c]) => [`${n} (merge)`, c]),
  ...splicedIntoWord,
];

const passRows: [string, string][] = [
  ["a PR body heredoc that names a push", `gh pr create --title t --body "$(cat <<'E'\nRun ${PUSH} after review.\nE\n)"`],
  ["eval of a benign cat heredoc", `eval "$(cat <<'E'\necho ok\nE\n)"`],
  ["eval of a tool's output, unknowable statically (D6 residual)", `eval "$(ssh-agent -s)"`],
  ["eval of an echo whose arguments are the spliced output", `eval "echo $(echo ${PUSH})"`],
  ["eval of an assignment holding a cat heredoc's output", `eval "X='$(cat <<'E'\n${PUSH}\nE\n)'"`],
];

function bash(command: string): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });
}

function decisionOf(stdout: string): string | null {
  if (stdout === "") return null;
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : stdout;
}

describe("eval and -c over a substitution whose output is literal", () => {
  it.each(denyRows)("denies %s", async (_, command) => {
    const result = await handle(bash(command), {}, port);

    expect(decisionOf(result.stdout)).toBe("deny");
  });

  it.each(passRows)("passes %s", async (_, command) => {
    const result = await handle(bash(command), {}, port);

    expect(decisionOf(result.stdout)).toBeNull();
  });
});

// CI builds before it tests; locally run `pnpm build` first.
const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tool-guard-eval-output-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function hook(command: string): string | null {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  const run = spawnSync(process.execPath, [join(dist, "bin.js"), "hook"], { input, env: { ...process.env, HOME: home }, encoding: "utf-8", timeout: 5000 });
  expect(run.status).toBe(0);
  return decisionOf(run.stdout);
}

describe("the built hook on eval and -c over a literal substitution", () => {
  it.each(denyRows)("denies %s", (_, command) => {
    expect(hook(command)).toBe("deny");
  });

  it.each(passRows)("passes %s", (_, command) => {
    expect(hook(command)).toBeNull();
  });
});
