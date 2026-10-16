import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WordToken } from "./lexer.js";
import { shellOperands } from "./shell-options.js";

/** Words the shells' option lexers read differently; each line is up to two of them, then the operands `A` and `B`. */
const OPTION_WORDS = [
  ...["-", "--", "+", "+-", "-c", "+c", "-s", "+s", "-o", "-O", "-x", "-cs", "-co", "-oc", "-cO", "-c-", "-x-"],
  ...["-0", "-c0", "-0c", "-b", "-bc", "+0s", "-oerrexit", "errexit", "--emulate", "sh", "--rcfile", "--norc"],
  ...["-oshoptionletters", "--sh-option-letters", "shoptionletters"],
];
const LINES = [[], ...OPTION_WORDS.map((w) => [w]), ...OPTION_WORDS.flatMap((a) => OPTION_WORDS.map((b) => [a, b]))].map((l) => [...l, "A", "B"]);
const WORDS = [...OPTION_WORDS, "A", "B"];

const word = (value: string): WordToken => ({ type: "word", value, dynamic: false, quoted: false, spliced: false, computed: false, refs: [], subs: [] });

/** What the reader says a line runs: `cmd W` for a `-c` string W, `script W` for a script file W, and `stdin`. */
function predicted(line: string[], shell: string): string[] {
  const { hasC, positional, readsStdin } = shellOperands(line.map(word), shell);
  const operand = positional ? [`${hasC ? "cmd" : "script"} ${positional.value}`] : [];
  return readsStdin ? [...operand, "stdin"] : operand;
}

/**
 * Runs every line under `shell` in a scratch dir where each word is both a command on PATH and a script file in the
 * working directory, each logging its own name, and stdin is a script that logs `stdin`. Returns what each line ran.
 */
async function observed(shell: string): Promise<string[][]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-table-"));
  const [bin, work, log] = [path.join(dir, "bin"), path.join(dir, "work"), path.join(dir, "log")];
  fs.mkdirSync(bin);
  fs.mkdirSync(work);
  WORDS.forEach((w, i) => {
    fs.writeFileSync(path.join(bin, w), `#!/bin/sh\necho "$CASE cmd ${i}" >> "$LOG"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(work, w), `echo "$CASE script ${i}" >> "$LOG"\n`);
  });
  fs.writeFileSync(path.join(dir, "stdin"), 'echo "$CASE stdin" >> "$LOG"\n');
  const quote = (w: string): string => `'${w}'`;
  const driver = LINES.map((line, n) => `CASE=${n} ${shell} ${line.map(quote).join(" ")} < ../stdin > /dev/null 2>&1`);
  fs.writeFileSync(path.join(dir, "driver.sh"), `${driver.join("\n")}\n`);
  try {
    await new Promise((resolve) => {
      const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ZDOTDIR: dir, LOG: log };
      spawn("bash", ["../driver.sh"], { cwd: work, env, stdio: "ignore" }).on("close", resolve);
    });
    return parseLog(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parseLog(text: string): string[][] {
  const runs: string[][] = LINES.map(() => []);
  for (const [n, kind, i] of text.trim().split("\n").filter(Boolean).map((l) => l.split(" "))) {
    runs[Number(n)]?.push(kind === "stdin" ? "stdin" : `${kind} ${WORDS[Number(i)]}`);
  }
  return runs;
}

const located = (shell: string): string | null => {
  const found = spawnSync("bash", ["-c", `command -v ${shell}`], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : null;
};

describe("the option reader agrees with each real shell on a generated table (TP-3221)", () => {
  it.each(["bash", "zsh", "dash", "sh"])("reads every line %s runs as it runs it", async (shell) => {
    const at = located(shell);
    if (at === null) return;
    const runs = await observed(at);
    const missed = LINES.flatMap((line, n) => {
      const reading = predicted(line, shell);
      return (runs[n] ?? []).filter((ran) => !reading.includes(ran)).map((ran) => `${shell} ${line.join(" ")}: ran ${ran}, read ${reading.join(", ")}`);
    });
    expect(missed).toEqual([]);
    expect(runs.filter((r) => r.length > 0).length).toBeGreaterThan(LINES.length / 4);
  }, 120_000);
});
