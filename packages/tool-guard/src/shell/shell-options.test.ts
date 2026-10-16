import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifyContext } from "../types.js";
import { zshOptionWord } from "./shell-options.js";

const REPO = "/home/you/projects/app";
const PUSH = "git push origin HEAD:main";
const TEXT = `'${PUSH}'`;

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: (file) => (file === `${REPO}/x.sh` ? `${PUSH}\n` : file === `${REPO}/ok.sh` ? "echo hi\n" : null),
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
  ["a script file after zsh's digit option 0", "zsh -0 ./x.sh"],
  ["a script file after zsh's digit option 1", "zsh -1 ./x.sh"],
  ["a script file after zsh's trailing -", "zsh -x- ./x.sh"],
  ["a script file after zsh's lone +", "zsh + ./x.sh"],
  ["a script file zsh's +s takes back from -s", "zsh -s +s ./x.sh"],
  ["a script file dash's +s takes back from -s", "dash -s +s ./x.sh"],
  ["bash's +c", `bash +c ${TEXT}`],
  ["zsh's +c", `zsh +c ${TEXT}`],
  ["dash's +c", `dash +c ${TEXT}`],
  ["sh's +c", `sh +c ${TEXT}`],
  ["bash's +ic", `bash +ic ${TEXT}`],
  ["bash's +co taking a name", `bash +co errexit ${TEXT}`],
  ["bash's +c before --", `bash +c -- ${TEXT}`],
  ["dash's +c after a lone +", `dash + -c ${TEXT}`],
  ["zsh's +0c", `zsh +0c ${TEXT}`],
  ["zsh's +c0", `zsh +c0 ${TEXT}`],
  ["zsh's +c after --emulate", `zsh --emulate sh +c ${TEXT}`],
  ["zsh's -c0", `zsh -c0 ${TEXT}`],
  ["zsh's -0c", `zsh -0c ${TEXT}`],
  ["zsh's -c1", `zsh -c1 ${TEXT}`],
  ["zsh's -c9", `zsh -c9 ${TEXT}`],
  ["zsh's -c- ending the options", `zsh -c- ${TEXT}`],
  ["a versioned zsh's -c0", `zsh5 -c0 ${TEXT}`],
  ["a restricted zsh's -c0", `rzsh -c0 ${TEXT}`],
  ["zsh's -b once SH_OPTION_LETTERS keeps it a letter", `zsh -o shoptionletters -b -c ${TEXT}`],
  ["a pipe into zsh -0", `echo ${TEXT} | zsh -0`],
  ["bash's +s, which still reads stdin", `bash +s foo <<< ${TEXT}`],
  ["dash's stdin after its -c string under -s", `dash -sc true <<< ${TEXT}`],
  ["sh's stdin after its -c string under -s", `sh -s -c true <<< ${TEXT}`],
  ["a pipe into dash after its -c string under -s", `echo ${TEXT} | dash -cs true`],
  ["//dev/stdin as the script file", `bash //dev/stdin <<< ${TEXT}`],
  ["/dev//stdin as the script file", `bash /dev//stdin <<< ${TEXT}`],
  ["/dev/./stdin as the script file", `bash /dev/./stdin <<< ${TEXT}`],
  ["/dev/../dev/stdin as the script file", `bash /dev/../dev/stdin <<< ${TEXT}`],
  ["/proc/thread-self/fd/0 as the script file", `bash /proc/thread-self/fd/0 <<< ${TEXT}`],
  ["a pipe into //dev/stdin as the script file", `echo ${TEXT} | bash //dev/stdin`],
  ["/dev/stdin naming a < file", "bash /dev/stdin < ./x.sh"],
  ["/dev/stdin after -- naming a < file", "bash -- /dev/stdin < ./x.sh"],
  ["/dev/stdin after - naming a < file", "bash - /dev/stdin < ./x.sh"],
  ["zsh's /dev/fd/0 naming a < file", "zsh /dev/fd/0 < ./x.sh"],
  ["sh's /proc/self/fd/0 naming a < file", "sh /proc/self/fd/0 < ./x.sh"],
  ["dash's /dev/stdin naming a < file", "dash /dev/stdin < ./x.sh"],
  ["a <> file on stdin", "bash <> ./x.sh"],
  ["a < file replacing an earlier here-string", "bash /dev/stdin <<< 'echo hi' < ./x.sh"],
  ["a run-time script operand, which may name stdin", `bash $X <<< ${TEXT}`],
  ["a run-time script operand before a < file", "bash $X < ./x.sh"],
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
    "bash +c 'echo hi'",
    "zsh -c0 'echo hi'",
    "dash -sc 'echo hi' <<< 'echo hi'",
    "bash /dev/stdin < ./ok.sh",
    "bash -- /dev/stdin < ./ok.sh",
    "bash - /dev/stdin < ./ok.sh",
    "zsh /dev/fd/0 < ./ok.sh",
    "sh /proc/self/fd/0 < ./ok.sh",
    "dash /dev/stdin < ./ok.sh",
  ])("allows %s", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

const KNOWN_SHELLS = new Set(["bash", "zsh", "zsh5", "rzsh", "dash", "sh"]);
describe("zsh's option lexer, which its startup and emulate share (TP-3221)", () => {
  it.each([
    ["-c0", false, { letters: "c0", optionName: null, takesNext: false, endsOptions: false }],
    ["+0c", false, { letters: "0c", optionName: null, takesNext: false, endsOptions: false }],
    ["-co", false, { letters: "c", optionName: null, takesNext: true, endsOptions: false }],
    ["-xoerrexit", false, { letters: "x", optionName: "errexit", takesNext: false, endsOptions: false }],
    ["-c-", false, { letters: "c-", optionName: null, takesNext: false, endsOptions: true }],
    ["+", false, { letters: "", optionName: null, takesNext: false, endsOptions: true }],
    ["--", false, { letters: "-", optionName: null, takesNext: false, endsOptions: true }],
    ["-bc", false, { letters: "bc", optionName: null, takesNext: false, endsOptions: true }],
    ["-bc", true, { letters: "bc", optionName: null, takesNext: false, endsOptions: false }],
  ] as const)("reads %s (SH_OPTION_LETTERS %s)", (word, shLetters, read) => {
    expect(zshOptionWord(word, shLetters)).toEqual(read);
  });

  it.each(["A", "--emulate", "+-errexit"])("reads %s as no short-option word", (word) => {
    expect(zshOptionWord(word, false)).toBeNull();
  });
});

const has = (shell: string): boolean => spawnSync(shell, ["-c", "true"]).status === 0;
const SHELLS_HERE = new Set([...KNOWN_SHELLS].filter(has));

/**
 * Runs `line` under `runner` in a scratch dir holding `x.sh`, with zsh reading no startup files, and reports whether it
 * created `mk`. A run that hangs is cut off.
 */
function runs(line: string, runner = "bash"): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-options-"));
  try {
    fs.writeFileSync(path.join(dir, "s.sh"), `${line}\n`);
    fs.writeFileSync(path.join(dir, "x.sh"), "touch mk\n");
    fs.writeFileSync(path.join(dir, "ok.sh"), "true\n");
    const [program = "bash", ...flags] = runner.split(" ");
    spawnSync(program, [...flags, "s.sh"], { cwd: dir, env: { ...process.env, ZDOTDIR: dir }, stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
    return fs.existsSync(path.join(dir, "mk"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!SHELLS_HERE.has("bash"))("each shell runs the text behind its options (TP-3221)", () => {
  it.each(
    PUSH_ROUTES.filter(([, line]) => !line.includes("--emulate=") && !line.startsWith("="))
      .map(([form, line]) => [form, line.replaceAll(TEXT, "'touch mk'").replace("/usr/bin/zsh", "zsh")] as const),
  )("runs the text behind %s", (_form, line) => {
    const shell = line.split(" ").find((w) => KNOWN_SHELLS.has(w)) ?? "";
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

const FD_SHELLS = ["bash", "zsh -f", "dash", "sh"];
const FD_OPERANDS = ["/dev/stdin", "-- /dev/stdin", "- /dev/stdin", "/dev/fd/0", "/proc/self/fd/0"];
/** Each shell runs the file a `<` redirect opens on the descriptor its script operand names; a file name completes the line. */
const FD_FILE_LINES = FD_SHELLS.flatMap((shell) => [...FD_OPERANDS.map((operand) => `${shell} ${operand} <`), `${shell} /dev/fd/3 3<`]);
/** Each shell runs a descriptor the line cannot show; the premise sets it up first, as an earlier line or the caller could. */
const UNKNOWABLE = FD_SHELLS.flatMap((shell) => [
  [`${shell} < $F`, "F=./x.sh"],
  [`${shell} /dev/stdin < $F`, "F=./x.sh"],
  [`${shell} $X < $F`, "F=./x.sh"],
  [`${shell} -s < $F`, "F=./x.sh"],
  [`${shell} /dev/stdin <&3`, "exec 3< ./x.sh"],
  [`${shell} <&3`, "exec 3< ./x.sh"],
  [`${shell} /dev/fd/3`, "exec 3< ./x.sh"],
  [`${shell} < /dev/fd/3`, "exec 3< ./x.sh"],
  [`${shell} /dev/stdin < /dev/fd/3 3< ./ok.sh`, "exec 3< ./x.sh"],
]);
const shellHere = (line: string): boolean => SHELLS_HERE.has(line.split(" ")[0] ?? "");

describe("a shell's stdin source is read from one model (TP-3241)", () => {
  it.each(FD_FILE_LINES)("denies %s a script holding a push", async (line) => {
    expect(await verdict(`${line} ./x.sh`)).toBe("deny");
  });

  it.each(FD_FILE_LINES)("allows %s a harmless script", async (line) => {
    expect(await verdict(`${line} ./ok.sh`)).toBe("pass");
  });

  it.each(UNKNOWABLE)("denies %s, whose script the line cannot show", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each(["bash -c 'echo hi' < $F", "bash $X", "bash ./ok.sh < $F"])("allows %s, which runs no unknowable descriptor", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

describe.skipIf(!SHELLS_HERE.has("bash"))("each shell runs the descriptor its operand names (TP-3241)", () => {
  it.each(FD_FILE_LINES.filter(shellHere))("%s runs the file, and only it", (line) => {
    expect([runs(`${line} ./x.sh`), runs(`${line} ./ok.sh`)]).toEqual([true, false]);
  });

  it.each(UNKNOWABLE.filter(([line]) => shellHere(line ?? "")))("%s runs the script %s sets up", (line, setup) => {
    expect(runs(`${setup}; ${line}`)).toBe(true);
  });
});

const ALL = ["bash", "zsh -f", "dash"];
/**
 * Each line, given the text it pipes or redirects and its script file, and the shells that run that text when they
 * run the line. A target naming a descriptor feeds what that descriptor held (`< /dev/stdin` keeps the pipe); zsh's
 * MULTIOS joins every source on a descriptor; `00<` is fd 0.
 */
const SOURCE_ROWS: Array<[string, (text: string, file: string) => string, string[]]> = [
  ...["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0", "/proc/thread-self/fd/0", "//dev/stdin", "/dev/./stdin", '"/dev/stdin"'].map(
    (target): [string, (text: string) => string, string[]] => [`a pipe kept by < ${target}`, (text) => `echo '${text}' | bash < ${target}`, ALL],
  ),
  ["a pipe kept by 0< /dev/stdin", (text) => `echo '${text}' | bash 0< /dev/stdin`, ALL],
  // `<>` holds the pipe open for writing, so the shell never reads its end and the text has to exit.
  ["a pipe kept by <> /dev/stdin", (text) => `echo '${text}; exit' | bash <> /dev/stdin`, ALL],
  ["a pipe kept by < /dev/stdin under a /dev/stdin operand", (text) => `echo '${text}' | bash /dev/stdin < /dev/stdin`, ALL],
  ...["bash -s", "sh -s", "dash -s", "zsh -s", "bash --", "bash -", "bash --norc"].map(
    (shell): [string, (text: string) => string, string[]] => [`a pipe into ${shell} kept by < /dev/stdin`, (text) => `echo '${text}' | ${shell} < /dev/stdin`, ALL],
  ),
  ["a here-string kept by < /dev/stdin", (text) => `bash <<< '${text}' < /dev/stdin`, ["bash", "zsh -f"]],
  ["a heredoc kept by < /dev/stdin", (text) => `bash <<E < /dev/stdin\n${text}\nE`, ALL],
  ["a pipe on fd 3 through 3< /dev/stdin", (text) => `echo '${text}' | bash /dev/fd/3 3< /dev/stdin`, ALL],
  ["stdin naming fd 3 after 3< opens it", (_text, file) => `bash /dev/stdin 3< ${file} < /dev/fd/3`, ALL],
  ["zsh joining a pipe with a < file", (text) => `zsh -c "echo '${text}' | bash < ./ok.sh"`, ALL],
  ["zsh joining two < files", (_text, file) => `zsh -c 'bash < ${file} < ./ok.sh'`, ALL],
  ["zsh joining a < file with a here-string", (_text, file) => `zsh -c "bash < ${file} <<< 'echo hi'"`, ALL],
  ["zsh joining a < file with a heredoc", (_text, file) => `zsh -c 'bash < ${file} <<E\necho hi\nE'`, ALL],
  ["zsh joining a here-string with a < file", (text) => `zsh -c "bash <<< '${text}' < ./ok.sh"`, ALL],
  ["zsh joining two < files under /dev/stdin", (_text, file) => `zsh -c 'bash /dev/stdin < ${file} < ./ok.sh'`, ALL],
  ["zsh joining a < file and a here-string under /dev/stdin", (_text, file) => `zsh -c "bash /dev/stdin < ${file} <<< 'echo hi'"`, ALL],
  ["zsh joining two files on fd 3", (_text, file) => `zsh -c 'bash /dev/fd/3 3< ${file} 3< ./ok.sh'`, ALL],
  ["a zsh line joining a < file and a here-string", (_text, file) => `bash /dev/stdin < ${file} <<< 'echo hi'`, ["zsh -f"]],
  ["a zsh line joining a pipe and a < file", (text) => `echo '${text}' | bash < ./ok.sh`, ["zsh -f"]],
  ["00< as stdin", (_text, file) => `bash 00< ${file}`, ["bash"]],
  ["00< under a /dev/stdin operand", (_text, file) => `bash /dev/stdin 00< ${file}`, ALL],
  ["000< under a /dev/fd/0 operand", (_text, file) => `bash /dev/fd/0 000< ${file}`, ALL],
];
const unescaped = (line: string): string => line.replaceAll("\\n", "\n");

describe("every source on the descriptor a shell runs is read (TP-3241)", () => {
  it.each(SOURCE_ROWS)("denies a push behind %s", async (_form, line) => {
    expect(await verdict(unescaped(line(PUSH, "./x.sh")))).toBe("deny");
  });

  it.each(SOURCE_ROWS)("allows a harmless script behind %s", async (_form, line) => {
    expect(await verdict(unescaped(line("echo hi", "./ok.sh")))).toBe("pass");
  });
});

describe.skipIf(!["bash", "zsh", "dash"].every((shell) => SHELLS_HERE.has(shell)))("each shell runs the sources the model reads (TP-3241)", () => {
  it.each(SOURCE_ROWS)("%s runs the push in the shells listed, and the harmless line in none", (_form, line, pushers) => {
    const ran = ALL.filter((runner) => runs(unescaped(line("touch mk", "./x.sh")), runner));
    const harmless = ALL.filter((runner) => runs(unescaped(line("true", "./ok.sh")), runner));
    expect([ran, harmless]).toEqual([pushers, []]);
  });
});
