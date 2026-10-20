import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";
import { extractCommands } from "./shell/commands.js";

const PUSH = "git push origin HEAD:main";
const PUSHED = "bash.merge.git-push-protected";
const CAP = 64 * 1024;

/** A real directory the shell sees: `x.sh` holds the push, `ok.sh` is harmless, `big.sh` hides the push past the read cap. */
const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-guard-procsub-")));
afterAll(() => {
  chmodSync(join(home, "unreadable.sh"), 0o600);
  rmSync(home, { recursive: true, force: true });
});
writeFileSync(join(home, "x.sh"), `${PUSH}\n`);
writeFileSync(join(home, "ok.sh"), "echo ok\n");
writeFileSync(join(home, "evil.sh"), `${PUSH}\n`);
writeFileSync(join(home, "big.sh"), `${"#".repeat(CAP + 400)}\n${PUSH}\n`);
writeFileSync(join(home, "unreadable.sh"), `${PUSH}\n`);
chmodSync(join(home, "unreadable.sh"), 0);

const port: HookPort = { context: nodeContext(home), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

async function verdict(command: string): Promise<{ decision: string | null; spelling: string | undefined }> {
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  const { stdout, log } = await handle(event, {}, port);
  const decision = stdout === "" ? null : (/"permissionDecision":"(\w+)"/.exec(stdout)?.[1] ?? "unknown");
  return { decision, spelling: log[0]?.split("\t")[4] };
}

/** Bodies that run what the shell's own stdin or trailing operands hold, so main's reading of those must survive the substitution. */
const STDIN_BODIES = ["cat | sh", "cat | bash", "cat - | sh", "cat /dev/stdin | sh", "cat <&0 | sh", "tee /dev/null | sh", "head -c 999 | sh", 'eval "$(cat)"', "read l; $l"];
const STDIN_LINES = [...STDIN_BODIES.map((body) => `bash <(echo '${body}') < ./evil.sh`), "bash <(echo 'cat | sh') 0< ./evil.sh", "bash <(< ./x.sh)", "zsh <(< ./x.sh)"];
const RELAY_LINES = [
  `bash <(echo 'bash "$@"') -c '${PUSH}'`,
  `sh <(echo 'sh "$@"') -c '${PUSH}'`,
  `zsh <(echo 'zsh "$@"') -c '${PUSH}'`,
  `bash <(echo 'sh "$@"') -c '${PUSH}'`,
  `bash <(echo 'bash "$@"') -ec '${PUSH}'`,
  `bash <(echo 'bash "$@"') -e -c '${PUSH}'`,
  `bash <(echo 'bash "$@"') -O extglob -c '${PUSH}'`,
  `bash <(echo 'bash "$1" "$2"') -c '${PUSH}'`,
  `bash <(echo 'bash "$@"') -c '${PUSH}' x`,
];
const NULLCMD_LINES = [
  "bash <(< ./x.sh; echo)",
  "zsh <(< ./x.sh; echo)",
  "bash <(< ./x.sh | cat)",
  "bash <(echo; < ./x.sh)",
  "bash <(< ./x.sh && true)",
  "zsh <(true; < ./x.sh)",
  "bash <(< ./x.sh; cat ./ok.sh)",
  "bash <({ < ./x.sh; })",
  "bash <((< ./x.sh))",
  "zsh <(<./x.sh;echo)",
  "bash <(0< ./x.sh; echo)",
];
const OPERAND_LINES = [
  "bash <(echo 'bash $1') ./evil.sh",
  "bash <(echo 'bash \"$@\"') ./evil.sh",
  "bash <(echo 'source \"$1\"') ./evil.sh",
  "bash <(echo '. \"$1\"') ./evil.sh",
  `bash <(echo 'exec "$@"') ${PUSH}`,
  `bash <(echo '"$@"') ${PUSH}`,
  `bash <(echo ${PUSH}) arg`,
];
/** A redirect a substitution completes takes nothing more, so the substitution or file after it stays the shell's script. */
const REDIRECTED_LINES = [
  `bash 2>/dev/null <(echo '${PUSH}')`,
  `bash 2>&1 <(echo '${PUSH}')`,
  `bash </dev/null <(echo '${PUSH}')`,
  `bash >/dev/null <(echo '${PUSH}')`,
  `bash -x 2>/dev/null <(echo '${PUSH}')`,
  `bash 3<./ok.sh <(echo '${PUSH}')`,
  `bash < ./ok.sh <(echo '${PUSH}')`,
  "bash >out <(cat ./x.sh)",
  `source 2>/dev/null <(echo '${PUSH}')`,
  `bash < <(echo 'echo hi') <(echo '${PUSH}')`,
  "bash > >(cat) ./evil.sh",
  "bash 2> >(cat) ./evil.sh",
  "sh 2> >(cat) ./evil.sh",
  "source 2> >(cat) ./evil.sh",
  "bash < <(echo 'echo hi') ./evil.sh",
];
/** A body that prints under one shell's reading of its `{name}` words and runs another command under another. */
const NAMED_FD_LINES = [
  `bash <({x}>/dev/null echo '${PUSH}')`,
  `source <({fd}</dev/null echo '${PUSH}')`,
  `bash <(echo hi; {x}>/dev/null echo '${PUSH}')`,
];

describe("a shell or source running a process substitution as its script", () => {
  it.each([...STDIN_LINES, "bash <(echo 'cat | sh') < \"$F\"", ...OPERAND_LINES, ...RELAY_LINES, ...NULLCMD_LINES, ...REDIRECTED_LINES, ...NAMED_FD_LINES, `bash <({x} >/dev/null echo '${PUSH}')`])("denies a shell's own stdin or operands: %s", async (command) => {
    const { decision } = await verdict(command);

    expect(decision).toBe("deny");
  });

  it.each([
    "while read -r l; do echo \"$l\"; done < <(ls); echo done",
    "exec 3< <(ls); cat <&3",
    "exec > >(tee log); echo hi",
    "exec 2> >(tee -a err.log >&2); make",
    "while read -r l; do echo \"$l\"; done < <(ls) | sort",
    "exec 5< <(printf 'a\\nb\\n'); while read -r -u 5 x; do echo \"$x\"; done",
    'exec {fd}< <(ls); read -r -u "$fd" l; echo "$l"',
    "bash <(echo a) <(echo PUSH)",
    "diff <(sort a) <(sort b)",
    "bash <(echo 'echo hi') -s x",
    "bash <(echo 'echo hi') -x",
    "bash <(echo 'echo hi') -O extglob",
    "bash <(< ./ok.sh)",
    "source <(kubectl completion zsh)",
  ])("allows a redirect that takes the substitution: %s", async (command) => {
    const { decision } = await verdict(command);

    expect(decision).toBeNull();
  });

  it.each([
    ["bash with echo", `bash <(echo '${PUSH}')`],
    ["zsh with echo", `zsh <(echo '${PUSH}')`],
    ["bash with cat of a file", "bash <(cat ./x.sh)"],
    ["sh with printf", `sh <(printf '${PUSH}')`],
    ["source", `source <(echo ${PUSH})`],
    ["dot", `. <(echo ${PUSH})`],
    ["source with cat", "source <(cat ./x.sh)"],
    ["a harmless echo before the push", `bash <(echo hi; echo ${PUSH})`],
    ["cat with --", "bash <(cat -- ./x.sh)"],
    ["sudo", `sudo bash <(echo ${PUSH})`],
    ["env", `env bash <(echo ${PUSH})`],
    ["exec", `exec bash <(echo ${PUSH})`],
    ["an assignment", `FOO=1 bash <(echo ${PUSH})`],
    ["an option", `bash -x <(echo ${PUSH})`],
    ["a double dash", `bash -- <(echo ${PUSH})`],
    ["a -c string", `bash -c "bash <(echo ${PUSH})"`],
    ["eval", `eval "bash <(echo ${PUSH})"`],
    ["piped text", `echo "bash <(echo ${PUSH})" | bash`],
    ["xargs", `xargs -I{} bash <(echo ${PUSH})`],
    ["a redirect before it", `bash 2> >(cat) <(echo ${PUSH})`],
  ])("denies %s", async (_, command) => {
    const { decision, spelling } = await verdict(command);

    expect(decision).toBe("deny");
    expect(spelling).toBe(PUSHED);
  });

  it.each([
    ["a missing file", "bash <(cat ./missing.sh)"],
    ["an unreadable file", "bash <(cat ./unreadable.sh)"],
    ["a file past the read cap", "bash <(cat ./big.sh)"],
    ["a sourced file past the read cap", "source <(cat ./big.sh)"],
  ])("fails closed on %s", async (_, command) => {
    const { decision, spelling } = await verdict(command);

    expect(decision).toBe("deny");
    expect(spelling).toBe("bash.oversize");
  });

  it("denies a body whose texts pass the reading limit", async () => {
    const body = Array.from({ length: 6 }, (_, i) => `echo {fd}</dev/null hello${i}`).join("; ");

    const { decision } = await verdict(`bash <(${body})`);

    expect(decision).toBe("deny");
  });

  it.each([
    ["an echo that does nothing", "bash <(echo 'echo hi')"],
    ["source with an echo that does nothing", "source <(echo 'echo hi')"],
    ["a harmless file", "bash <(cat ./ok.sh)"],
    ["a harmless sourced file", ". <(cat ./ok.sh)"],
    ["diff", "diff <(echo a) <(echo b)"],
    ["git diff", "git diff <(echo a) <(echo b)"],
    ["cat of two substitutions", "cat <(echo a) <(echo b)"],
    ["comm", "comm -12 <(sort a) <(sort b)"],
    ["paste", "paste <(echo a) <(echo b)"],
    ["tee into a substitution", "cat file | tee >(grep x) >/dev/null"],
    ["-s, where it is a positional parameter", `bash -s <(echo ${PUSH})`],
    ["-c STR, where it is a positional parameter", `bash -c 'echo hi' <(echo ${PUSH})`],
    ["a substitution as stdin", "bash < <(echo 'echo hi')"],
    ["a completion script", "source <(kubectl completion bash)"],
    ["a dot completion script", ". <(rbenv init -)"],
    ["a zsh init script", "source <(fzf --zsh)"],
    ["a downloaded script", "bash <(curl -s https://example.invalid/i.sh)"],
    ["a body that changes directory", "bash <(cd /tmp; echo hi)"],
  ])("allows %s", async (_, command) => {
    const { decision } = await verdict(command);

    expect(decision).toBeNull();
  });

  // A body the guard does not model gets the verdict the same program piped into the same shell gets (TP-3380 asks whether that should change).
  it.each([
    ["bash <(echo \"$CMD\")", "echo \"$CMD\" | bash"],
    ["bash <(cat)", "cat | bash"],
    ["bash <(cat a b)", "cat a b | bash"],
    ["bash <(cat -n ./x.sh)", "cat -n ./x.sh | bash"],
    ["bash <(head -n1 ./x.sh)", "head -n1 ./x.sh | bash"],
    ["source <(kubectl completion bash)", "kubectl completion bash | bash"],
    ["bash <(curl -s https://example.invalid/i.sh)", "curl -s https://example.invalid/i.sh | bash"],
  ])("gives %s the verdict of %s", async (substitution, piped) => {
    const [a, b] = [await verdict(substitution), await verdict(piped)];

    expect(a.decision).toBe(b.decision);
  });
});

describe("the arguments a process substitution leaves on a command", () => {
  const args = (src: string, name: string) => (extractCommands(src, { cwd: home, home }).find((cmd) => cmd.name === name)?.args ?? []).map((word) => word.value);

  it("adds none to a command that is not a shell", () => {
    expect(args("diff <(echo a) <(echo b)", "diff")).toEqual([]);
    expect(args("git diff <(echo a) <(echo b)", "git")).toEqual(["diff"]);
  });

  it("leaves a substitution a redirect awaits with that redirect", () => {
    expect(args("bash < <(echo hi)", "bash")).toEqual([]);
    expect(args("tee > >(cat)", "tee")).toEqual([]);
    expect(args("bash 2> >(cat) ./x.sh", "bash")).toEqual(["./x.sh"]);
  });

  it("keeps the operand on a shell", () => {
    expect(args("bash <(echo hi)", "bash")).toEqual(["/dev/fd/63"]);
    expect(args("bash 2>/dev/null <(echo hi)", "bash")).toEqual(["/dev/fd/63"]);
    expect(args("bash < <(echo a) <(echo hi)", "bash")).toEqual(["/dev/fd/63"]);
  });
});

/** The premise itself: what real shells do with each line, with a fake `git` first on PATH that logs its arguments. */
const [bin, scratch] = [mkdtempSync(join(tmpdir(), "tool-guard-procsub-bin-")), mkdtempSync(join(tmpdir(), "tool-guard-procsub-run-"))];
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "git"), '#!/bin/sh\necho "$@" >> "$FAKE_GIT_LOG"\n');
chmodSync(join(bin, "git"), 0o755);
writeFileSync(join(scratch, "x.sh"), `${PUSH}\n`);
writeFileSync(join(scratch, "evil.sh"), `${PUSH}\n`);
writeFileSync(join(scratch, "ok.sh"), "echo ok\n");
afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

function pushes(shell: string, line: string): boolean {
  const log = join(scratch, `log-${Math.random().toString(36).slice(2)}`);
  const flags = shell === "zsh" ? ["-f", "-c", line] : ["-c", line];
  spawnSync(shell, flags, { cwd: scratch, env: { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_GIT_LOG: log }, timeout: 10_000 });
  try {
    return readFileSync(log, "utf8").includes("push");
  } catch {
    return false;
  }
}

const haveShell = (shell: string): boolean => spawnSync(shell, ["-c", "true"]).status === 0;

describe.each(["bash", "zsh"])("under real %s", (shell) => {
  const runs = haveShell(shell);

  it.skipIf(!runs).each([
    `bash <(echo '${PUSH}')`,
    `zsh <(echo '${PUSH}')`,
    "bash <(cat ./x.sh)",
    `source <(echo ${PUSH})`,
    `. <(echo ${PUSH})`,
    `bash <(echo hi; echo ${PUSH})`,
  ])("a push through %s does push", (line) => {
    if (line.startsWith("zsh") && !haveShell("zsh")) return;

    expect(pushes(shell, line)).toBe(true);
  });

  it.skipIf(!runs).each([
    "bash <(echo 'echo hi')",
    `bash -s <(echo ${PUSH})`,
    `bash -c 'echo hi' <(echo ${PUSH})`,
    "diff <(echo a) <(echo b)",
  ])("%s does not push", (line) => {
    expect(pushes(shell, line)).toBe(false);
  });
});

describe("the shell's own stdin and operands under a real shell", () => {
  it.each([...STDIN_LINES, ...OPERAND_LINES, ...RELAY_LINES, ...NULLCMD_LINES, ...REDIRECTED_LINES, ...NAMED_FD_LINES])("%s pushes", (line) => {
    const pushing = ["bash", "zsh"].filter((shell) => haveShell(shell) && pushes(shell, line));

    expect(pushing.length).toBeGreaterThan(0);
  });
});
