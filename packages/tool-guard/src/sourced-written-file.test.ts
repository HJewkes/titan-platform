import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const HOME = "/home/you";
const STALE = `${HOME}/app/f`;
/** `f` already holds a benign script, which every line below overwrites before it runs it. */
const staleFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: (p) => {
    if (p === STALE) return "echo stale\n";
    throw new Error("ENOENT");
  },
  isFile: (p) => p === STALE,
};
const port: HookPort = { context: nodeContext(HOME, staleFs), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

const PUSH = "git push origin HEAD:main";
const MERGE = "gh pr merge 1 --squash";

/** Lines whose only route to the guarded command is a script the same line writes and then runs or sources. */
const reachedThroughWrite = (cmd: string): [string, string][] => [
  ["'.' of a file a cat heredoc writes", `cat > f <<'E'\n${cmd}\nE\n. ./f`],
  ["source of a file a cat heredoc writes", `cat > f <<'E'\n${cmd}\nE\nsource f`],
  ["bash of a file a cat heredoc writes", `cat > f <<'E'\n${cmd}\nE\nbash f`],
  ["sh of a file a cat heredoc writes", `cat > f <<'E'\n${cmd}\nE\nsh ./f`],
  ["'.' of a file the disk does not hold yet", `cat > new.sh <<'E'\n${cmd}\nE\n. ./new.sh`],
  ["'.' of a file an unquoted cat heredoc writes", `cat >| f <<E\n${cmd}\nE\n. ./f`],
  ["'.' of a file a cat here-string writes", `cat <<< '${cmd}' > f; . ./f`],
  ["'.' of a file echo writes", `echo '${cmd}' > f; . ./f`],
  ["'.' of a file printf writes", `printf '%s' '${cmd}' > f && . ./f`],
  ["'.' of a file echo writes through &>", `echo '${cmd}' &> f; . ./f`],
  ["'.' of a file zsh's echo - writes", `echo - ${cmd} > f; . ./f`],
  ["'.' of a file a second heredoc appends to", `cat > f <<'E'\necho hi\nE\ncat >> f <<'E'\n${cmd}\nE\n. ./f`],
  ["'.' of a file echo appends to over the disk text", `echo '${cmd}' >> f; . ./f`],
];

const denyRows = [...reachedThroughWrite(PUSH).map(([n, c]) => [`${n} (push)`, c]), ...reachedThroughWrite(MERGE).map(([n, c]) => [`${n} (merge)`, c])];

const passRows: [string, string][] = [
  ["bash of a benign file a cat heredoc writes", `cat > f <<'E'\necho hi\nE\nbash f`],
  ["a heredoc written to notes that nothing runs", `cat > notes.md <<'E'\n${PUSH}\nE\necho ok`],
  ["'.' of a benign file after a push is written elsewhere", `echo '${PUSH}' > notes.md; . ./f`],
  ["'.' of a file only opened before stdout moves on", `echo '${PUSH}' > f > g; . ./f`],
  ["'.' of a file whose push went to stderr instead", `echo '${PUSH}' > f >&2; . ./f`],
  ["a PR body heredoc that names a push", `gh pr create --title t --body "$(cat <<'E'\nRun ${PUSH} after review.\nE\n)"`],
];

function bash(command: string, cwd: string): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd, tool_input: { command } });
}

function decisionOf(stdout: string): string | null {
  if (stdout === "") return null;
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : stdout;
}

describe("a script the line writes and then runs", () => {
  it.each(denyRows)("denies %s", async (_, command) => {
    const result = await handle(bash(command, `${HOME}/app`), {}, port);

    expect(decisionOf(result.stdout)).toBe("deny");
  });

  it.each(passRows)("passes %s", async (_, command) => {
    const result = await handle(bash(command, `${HOME}/app`), {}, port);

    expect(decisionOf(result.stdout)).toBeNull();
  });
});

// CI builds before it tests; locally run `pnpm build` first.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tool-guard-written-file-"));
writeFileSync(join(home, "f"), "echo stale\n");
afterAll(() => rmSync(home, { recursive: true, force: true }));

function hook(command: string): string | null {
  const run = spawnSync(process.execPath, [join(dist, "bin.js"), "hook"], { input: bash(command, home), env: { ...process.env, HOME: home }, encoding: "utf-8", timeout: 5000 });
  expect(run.status).toBe(0);
  return decisionOf(run.stdout);
}

describe("the built hook on a script the line writes and then runs", () => {
  it.each(denyRows)("denies %s", (_, command) => {
    expect(hook(command)).toBe("deny");
  });

  it.each(passRows)("passes %s", (_, command) => {
    expect(hook(command)).toBeNull();
  });
});
