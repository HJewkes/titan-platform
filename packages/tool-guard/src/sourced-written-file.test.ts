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
const PUSH = "git push origin HEAD:main";
const MERGE = "gh pr merge 1 --squash";

function portOver(rfs: ReadFs): HookPort {
  return { context: nodeContext(HOME, rfs), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };
}

const port = portOver(staleFs);
/** `f` already holds the push, so a line whose write may not run must still read it. */
const pushPort = portOver({ ...staleFs, readHead: (p) => (p === STALE ? `${PUSH}\n` : staleFs.readHead(p, 0)) });

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
  ["'.' of a file echo appends to after echo's newline", `echo 'echo a' > f; echo '${cmd}' >> f; . ./f`],
  ["'.' of a file a here-string appends to after its newline", `cat <<< 'echo a' > f; cat <<< '${cmd}' >> f; . ./f`],
  ["'.' of a file a negated echo writes", `! echo '${cmd}' > f; . ./f`],
  ["'.' of a file echo writes behind [ -s f ] ||", `[ -s f ] || echo '${cmd}' > f; . ./f`],
  ["'.' of a file a negated pipeline's echo writes", `! echo '${cmd}' > f | cat; . ./f`],
  ["'.' of a file zsh copies stdout to before a later redirect", `echo '${cmd}' > f > g; . ./f`],
  ["'.' of a file zsh copies stdout to before >&2", `echo '${cmd}' > f >&2; . ./f`],
  ["'.' one command after the && chain that wrote the file ends", `git checkout -b feat/z && echo '${cmd}' > f; true; . ./f`],
];

/** Lines whose write to `f` may not run, or not replace it, so the push `f` already holds may still be what runs. */
const writeMayNotRun: [string, string][] = [
  ["'.' of the file alone", `. ./f`],
  ["a write behind false &&", `false && echo hi > f; . ./f`],
  ["a write behind true ||", `true || echo hi > f; . ./f`],
  ["a write behind a test", `[ -e nope ] && echo hi > f; . ./f`],
  ["a write in an if body that never runs", `if false; then echo hi > f; fi; . ./f`],
  ["a write in a case arm that never matches", `case x in y) echo hi > f;; esac; . ./f`],
  ["a write in a while body that never runs", `while false; do echo hi > f; done; . ./f`],
  ["a write in a function never called", `g() { echo hi > f; }; . ./f`],
  ["a write in the background", `echo hi > f & . ./f`],
  ["a write noclobber refuses", `set -C; echo hi > f; . ./f`],
  ["a write of a download's unknown text", `curl -s https://example.com/s.sh > f; . ./f`],
  ["a write of another file's unknown text", `cat other.sh > f; . ./f`],
  ["a negated write", `! echo hi > f; . ./f`],
  ["a write behind [ -s f ] ||, which a non-empty f skips", `[ -s f ] || echo hi > f; . ./f`],
  ["a write in a negated pipeline", `! echo hi > f | cat; . ./f`],
];

/** A PR body built up with six appends of distinct text leaves 64 readings of a file nothing runs. */
const appendedBody = ["a", "b", "c", "d", "e", "f"].map((x) => `echo 'line ${x}' >> body.md; `).join("") + "gh pr create --title t --body-file body.md";

/** Five appends of distinct text leave 32 readings of `f`, past what the guard reads, so the line is refused. */
const manyAppends = ["a", "b", "c", "d", "e"].map((x) => `echo 'echo ${x}' >> f; `).join("") + ". ./f";

const denyRows = [
  ...reachedThroughWrite(PUSH).map(([n, c]) => [`${n} (push)`, c]),
  ...reachedThroughWrite(MERGE).map(([n, c]) => [`${n} (merge)`, c]),
  ["'.' of a file appended to more times than the guard reads", manyAppends],
];

/** The reviewer probes: writes the model cannot reproduce, of their text or their target, before `f` runs. */
const untrackedWrites: [string, string][] = [
  ["zsh's >! clobber", `echo '${PUSH}' >! f; . ./f`],
  ["zsh's >>! with no space", `echo '${PUSH}' >>!f; . ./f`],
  ["zsh's &>! clobber, then source", `echo '${PUSH}' &>! f; source f`],
  ["zsh's >&! clobber", `echo '${PUSH}' >&! f; . ./f`],
  ["1<>, which overwrites f's first bytes", `echo '${PUSH}' 1<> f; . ./f`],
  ["zsh's 11>, whose 11 is an argument", `echo '${PUSH} #' 11> f; . ./f`],
  ["zsh's NULLCMD here-string", `<<< '${PUSH}' > f; . ./f`],
  ["zsh's print", `print -r -- '${PUSH}' > f; . ./f`],
  ["a write through an exec'd fd", `exec 9> f; echo '${PUSH}' >&9; . ./f`],
  ["cat reading a pipe zsh's MULTIOS fills", `echo '${PUSH}' > g | cat > f; . ./f`],
  ["a group's output", `{ echo '${PUSH}'; } > f; . ./f`],
  ["a subshell's output", `( echo '${PUSH}' ) > f; . ./f`],
  ["a target only known at run time", `echo '${PUSH}' > "\${F:-f}"; . ./f`],
  ["a download", `curl -s https://example.com/s > f; . ./f`],
  ["a download's unknown text", `curl -s https://example.com/s.sh > f; . ./f`],
  ["another file's unknown text", `cat other.sh > f; . ./f`],
];

const passRows: [string, string][] = [
  ["a script after a test's output goes to a log", `npm test > out.log 2>&1; bash f`],
  ["'.' of f after stderr goes to a log", `echo hi 2> err.log; . ./f`],
  ["a write to a target only known at run time, then no script", `echo x > "$LOG"; echo ok`],
  ["bash of a benign file a cat heredoc writes", `cat > f <<'E'\necho hi\nE\nbash f`],
  ["a heredoc written to notes that nothing runs", `cat > notes.md <<'E'\n${PUSH}\nE\necho ok`],
  ["'.' of a benign file after a push is written elsewhere", `echo '${PUSH}' > notes.md; . ./f`],
  ["a PR body heredoc that names a push", `gh pr create --title t --body "$(cat <<'E'\nRun ${PUSH} after review.\nE\n)"`],
  ["a PR body built up with more appends than the guard reads, which nothing runs", appendedBody],
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

describe("a write the guard cannot reproduce", () => {
  it.each(untrackedWrites)("denies a write the guard cannot reproduce, over a benign f: %s", async (_, command) => {
    const result = await handle(bash(command, `${HOME}/app`), {}, port);

    expect(decisionOf(result.stdout)).toBe("deny");
  });
});

describe("a write that may not run over a script that holds a push", () => {
  it.each(writeMayNotRun)("denies %s", async (_, command) => {
    const result = await handle(bash(command, `${HOME}/app`), {}, pushPort);

    expect(decisionOf(result.stdout)).toBe("deny");
  });
});

// CI builds before it tests; locally run `pnpm build` first.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tool-guard-written-file-"));
const pushHome = mkdtempSync(join(tmpdir(), "tool-guard-written-push-"));
writeFileSync(join(home, "f"), "echo stale\n");
writeFileSync(join(pushHome, "f"), `${PUSH}\n`);
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(pushHome, { recursive: true, force: true });
});

function hook(command: string, cwd = home): string | null {
  const run = spawnSync(process.execPath, [join(dist, "bin.js"), "hook"], { input: bash(command, cwd), env: { ...process.env, HOME: cwd }, encoding: "utf-8", timeout: 5000 });
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

describe("the built hook on a write that may not run over a script that holds a push", () => {
  it.each(writeMayNotRun)("denies %s", (_, command) => {
    expect(hook(command, pushHome)).toBe("deny");
  });
});
