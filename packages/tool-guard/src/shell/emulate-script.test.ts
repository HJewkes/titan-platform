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
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: () => null,
};

async function verdict(command: string): Promise<"deny" | "pass"> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const { stdout } = await handle(event, { PATH: "/usr/bin" }, port);
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

/** Each runs its last word as zsh code; the zsh block below proves the forms zsh accepts. */
const PUSH_ROUTES = [
  ["a zsh mode", `emulate zsh -c '${PUSH}'`],
  ["a reset sh mode", `emulate -R sh -c '${PUSH}'`],
  ["an option value before -c", `emulate sh -o x -c '${PUSH}'`],
  ["a real option before -c", `emulate sh -o errexit -c '${PUSH}'`],
  ["a plus-signed c", `emulate sh +c '${PUSH}'`],
  ["c inside a flag cluster", `emulate sh -xc '${PUSH}'`],
  ["a cluster that takes an option name", `emulate sh -co errexit '${PUSH}'`],
  ["a lone dash between -c and the text", `emulate sh -c - '${PUSH}'`],
  ["a dynamic word that may be -c", `emulate sh $f '${PUSH}'`],
  ["the builtin prefix", `builtin emulate zsh -c '${PUSH}'`],
  ["a dynamic word after a wrapper, an over-read since nohup runs no builtin", `nohup $X emulate zsh -c '${PUSH}'`],
] as const;

describe("emulate -c text is walked as eval (TP-3207)", () => {
  it.each(PUSH_ROUTES)("denies a push behind %s", async (_form, line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each([
    ["a variable holding the push", `s='${PUSH}'; `],
    ["an unknown variable", ""],
  ])('gives emulate zsh -c "$s" the verdict of eval "$s" for %s', async (_form, prefix) => {
    expect(await verdict(`${prefix}emulate zsh -c "$s"`)).toBe(await verdict(`${prefix}eval "$s"`));
  });

  it.each(["emulate -L zsh", "emulate zsh -c 'echo hi'", "emulate", "emulate -LR sh", "emulate sh -o errexit"])("allows %s", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

const zsh = spawnSync("zsh", ["-f", "-c", "true"]).status === 0;

describe.skipIf(!zsh)("zsh runs the text of each emulate form (TP-3207)", () => {
  function runs(line: string): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emulate-c-"));
    try {
      fs.writeFileSync(path.join(dir, "s.zsh"), `${line}\n`);
      spawnSync("zsh", ["-f", "s.zsh"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
      return fs.existsSync(path.join(dir, "mk"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([
    "emulate zsh -c 'touch mk'",
    "emulate -R sh -c 'touch mk'",
    "emulate sh -o errexit -c 'touch mk'",
    "emulate sh +c 'touch mk'",
    "emulate sh -xc 'touch mk'",
    "emulate sh -co errexit 'touch mk'",
    "emulate sh -c - 'touch mk'",
    "f=-c; emulate sh $f 'touch mk'",
  ])("runs %s", (line) => {
    expect(runs(line)).toBe(true);
  });
});

const PROTECTED = "git push --no-verify origin HEAD:main";

/** Read as zsh 5.9 reads them; the old `[-+][A-Za-z]*c[A-Za-z]*` reading passed every digit cluster here. */
const CLUSTER_ROWS = [
  ["regression: c then a digit", `emulate zsh -c2 '${PUSH}'`, "deny"],
  ["a digit then c", `emulate zsh -2c '${PROTECTED}'`, "deny"],
  ["c then a zero", `emulate zsh -c0 '${PROTECTED}'`, "deny"],
  ["a one then c", `emulate zsh -1c '${PROTECTED}'`, "deny"],
  ["c then several digits", `emulate zsh -c123 '${PROTECTED}'`, "deny"],
  ["a letter, c and a digit", `emulate zsh -xc2 '${PROTECTED}'`, "deny"],
  ["an sh mode with c then a digit", `emulate sh -c2 '${PROTECTED}'`, "deny"],
  ["a ksh mode with a digit then c", `emulate ksh -2c '${PROTECTED}'`, "deny"],
  ["a cluster closed by a dash", `emulate zsh -c- '${PROTECTED}'`, "deny"],
  ["a b cluster that ends the options", `emulate zsh -c -b '${PROTECTED}'`, "deny"],
  ["a mode after a lone dash", `emulate - zsh -c '${PROTECTED}'`, "deny"],
  ["a mode that looks like a flag", `emulate -- -c -c '${PROTECTED}'`, "deny"],
  ["a plus-signed mode", `emulate +L -c '${PROTECTED}'`, "deny"],
  ["an attached text, which zsh reads as options", `emulate zsh -c'${PROTECTED}'`, "pass"],
  ["an attached text after =, a bad option", `emulate zsh -c='${PROTECTED}'`, "pass"],
  ["-L, which zsh refuses with -c", `emulate -L zsh -c '${PROTECTED}'`, "pass"],
  ["a dash inside a cluster, a bad option string", `emulate zsh -c-x '${PROTECTED}'`, "pass"],
  ["a digit mode word with the text as a stray argument", `emulate -2c zsh '${PROTECTED}'`, "pass"],
] as const;

describe("emulate option clusters are read as zsh reads them (TP-3207)", () => {
  it.each(CLUSTER_ROWS)("%s: %s gets %s", async (_form, line, expected) => {
    expect(await verdict(line)).toBe(expected);
  });
});

/** Option words for the sweep: letters, digits, both signs, `o` with its name, `b`, `-lLR`, `-` and `--`. */
const SWEEP_WORDS = ["-c", "+c", "-c2", "-2c", "-c9", "-x", "-2", "+x", "-", "+", "--", "-c-", "-x-", "-c-x", "-co", "-coerrexit", "-o", "errexit", "-b", "-cb", "-xb", "-cL", "-cR", "-l", "-c "];
const SWEEP_PREFIXES = ["", "-R ", "-L ", "-l ", "-LR ", "- ", "-- ", "--R ", "-2 "];

function sweepLines(): string[] {
  const quote = (w: string) => (w.includes(" ") ? `'${w}'` : w);
  const lines = new Set<string>();
  for (const prefix of SWEEP_PREFIXES) {
    for (const mode of ["zsh", "sh", "ksh", "-c"]) {
      for (const word of SWEEP_WORDS) lines.add(`emulate ${prefix}${mode} ${quote(word)} '${PROTECTED}'`);
    }
  }
  for (const a of SWEEP_WORDS) for (const b of SWEEP_WORDS) lines.add(`emulate zsh ${quote(a)} ${quote(b)} '${PROTECTED}'`);
  return [...lines];
}

/** Runs each line in one zsh with a fake git that logs the row it ran in; returns the rows that ran and each stderr. */
function zshRuns(lines: string[], preamble = ""): { ran: Set<number>; stderr: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emulate-sweep-"));
  try {
    fs.mkdirSync(path.join(dir, "bin"));
    fs.mkdirSync(path.join(dir, "err"));
    fs.writeFileSync(path.join(dir, "bin", "git"), '#!/bin/sh\necho "$ROW" >> "$RAN_LOG"\n', { mode: 0o755 });
    const script = lines.map((line, i) => `(ROW=${i}; export ROW; ${line}) 2> err/${i}`).join("\n");
    fs.writeFileSync(path.join(dir, "s.zsh"), `${preamble}${script}\n`);
    const env = { PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, RAN_LOG: path.join(dir, "ran"), HOME: dir };
    spawnSync("zsh", ["-f", "s.zsh"], { cwd: dir, env, stdio: "ignore" });
    const log = fs.existsSync(path.join(dir, "ran")) ? fs.readFileSync(path.join(dir, "ran"), "utf8") : "";
    const ran = new Set(log.split("\n").filter(Boolean).map(Number));
    return { ran, stderr: lines.map((_, i) => fs.readFileSync(path.join(dir, "err", String(i)), "utf8")) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!zsh)("the guard denies an emulate line exactly where real zsh runs its text (TP-3207)", () => {
  it("agrees with zsh on the named cluster rows", () => {
    const { ran } = zshRuns(CLUSTER_ROWS.map(([, line]) => line.replace(PUSH, PROTECTED)));
    expect(CLUSTER_ROWS.map(([form], i) => [form, ran.has(i) ? "deny" : "pass"])).toEqual(CLUSTER_ROWS.map(([form, , expected]) => [form, expected]));
  });

  /** Which letters are options, and whether `b` ends them, follow the calling shell's SH_OPTION_LETTERS. */
  it("agrees with zsh under either option-letter set on every generated cluster, over-reading only an unknown option", async () => {
    const lines = sweepLines();
    const own = zshRuns(lines);
    const sh = zshRuns(lines, "setopt shoptionletters\n");
    const ran = new Set([...own.ran, ...sh.ran]);
    const disagreements: string[] = [];
    for (const [i, line] of lines.entries()) {
      const denied = (await verdict(line)) === "deny";
      const overRead = denied && !ran.has(i) && [own, sh].some((run) => /no such option|bad option/.test(run.stderr[i] ?? ""));
      if (denied !== ran.has(i) && !overRead) disagreements.push(`${ran.has(i) ? "zsh runs" : "zsh refuses"}: ${line}`);
    }
    expect(ran.size).toBeGreaterThan(100);
    expect(disagreements).toEqual([]);
  });
});
