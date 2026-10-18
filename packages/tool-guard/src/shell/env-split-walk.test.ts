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

async function hookStdout(command: string, ctx: ClassifyContext = context): Promise<string> {
  const port: HookPort = { context: ctx, now: () => new Date(0), loadDecide: async () => decide };
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  return (await handle(event, { PATH: "/usr/bin" }, port)).stdout;
}

async function verdict(command: string, ctx: ClassifyContext = context): Promise<"deny" | "pass"> {
  return (await hookStdout(command, ctx)).includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

/**
 * env's own options at the head of its `-S` string. GNU and uutils env have `-a`; BSD env has `-S`, `-u`, `-i` and
 * `-C` but no `-a`, so reading `-a` everywhere only over-reads there.
 */
const PUSH_ROUTES = [
  ["an argv0 option (GNU, uutils)", `env -S '-a sh zsh -c "${PUSH}"'`],
  ["an unset option", `env -S '-u X ${PUSH}'`],
  ["an empty environment", `env -S '-i ${PUSH}'`],
  ["a chdir option", `env -S '-C /tmp ${PUSH}'`],
  ["no option at all", `env -S '${PUSH}'`],
  ["a -S string attached to its option", `env -S"-u X" ${PUSH}`],
  ["a cluster ending in S", `env -iS '-u X ${PUSH}'`],
  ["a long option", `env --split-string='-u X ${PUSH}'`],
  ["a -S string inside a -S string", `env -S '-S "-u X ${PUSH}"'`],
  ["an unclosed quote", `env -S '-a "sh zsh -c x' ${PUSH}`],
  ["a backslash, one of env's escapes", `env -S 'git\\_push origin HEAD:main'`],
  ["a dynamic -S string", `s='-u X ${PUSH}'; env -S "$s"`],
  ["a command word env expands from an exported variable", "export G=git; env -S '-u X ${G} push origin HEAD:main'"],
  ["a command word env expands from an unknown variable", "env -S '-u X ${G} push origin HEAD:main'"],
  ["a bare $NAME command word, which env rejects", "env -S '$G push --no-verify origin HEAD:main'"],
  ["a bare $NAME after an unset option", "env -S '-u X $G push --no-verify origin HEAD:main'"],
  ["a bare $NAME double-quoted inside the -S string", `env -S '"$G" push --no-verify origin HEAD:main'`],
  ["a bare $NAME in a double-quoted -S string", `env -S "\\$G push --no-verify origin HEAD:main"`],
  ["a positional $1 command word", "env -S '$1 push --no-verify origin HEAD:main'"],
  ["a $( command word", "env -S '$(echo git) push --no-verify origin HEAD:main'"],
  ["a bare $NAME argv0", `env -S '-a $D zsh -c "git push --no-verify origin HEAD:main"'`],
  ["an exported option letter env expands at the head", `export O=-u; env -S '\${O} x ${PUSH}'`],
  ["a prefix-assigned option env expands at the head", `O=-u env -S '\${O} x ${PUSH}'`],
  ["an option env expands after a static one", `export O=-u; env -S '-i \${O} x ${PUSH}'`],
  ["a -S after an assignment, which uutils env honours (TP-3280)", `env FOO=1 -S '${PUSH}'`],
  ["a -S after an empty environment and an assignment", `env -i FOO=1 -S '${PUSH}'`],
  ["a --split-string after two assignments", `env FOO=1 BAR=2 --split-string='${PUSH}'`],
  ["an option in a -S string after an assignment", `env FOO=1 -S '-u X ${PUSH}'`],
  ["an assignment the shell does not name, which env still takes", `env a.b=1 ${PUSH}`],
  ["a zsh =git command word, which is no assignment", "env =git push origin HEAD:main"],
  ["a zsh =git command word after an assignment", "env A=1 =git push origin HEAD:main"],
  ["a zsh =git command word under sudo", "sudo env =git push origin HEAD:main"],
  ["a zsh =git command word under xargs", "echo x | xargs env =git push origin HEAD:main"],
] as const;

describe("env -S is split by env's rules and read as env's argv (TP-3210)", () => {
  it.each(PUSH_ROUTES)("denies a push behind %s", async (_form, line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each([
    ["a backslash escape", `env -S '${PUSH} \\c'`],
    ["a dynamic -S string", `s='-u X ${PUSH}'; env -S "$s"`],
    ["an exported option env expands at the head", `export O=-u; env -S '\${O} x ${PUSH}'`],
    ["a -S after an assignment", `env FOO=1 -S '${PUSH}'`],
  ])("denies a script file that pushes behind %s", async (_form, line) => {
    const readScript = (p: string) => (p === `${REPO}/p.sh` ? line : null);
    expect(await verdict("bash ./p.sh", { ...context, readScript })).toBe("deny");
  });

  it.each([
    ["a ${NAME} env expands, read as the shell's reference", "env -S '-u X cat ${HOME}/.npmrc'"],
    ["a tilde env leaves literal, still read by name", "env -S 'cat ~/.npmrc'"],
  ])("still denies a secret read through %s", async (_form, line) => {
    expect(await hookStdout(line)).toContain("secret-read");
  });

  it.each([
    ["an ambiguous option in an env a -S string runs", `env -S 'env --ig HOME ${PUSH}'`],
    ["an ambiguous option in a chained env", `env -S env env --ig HOME ${PUSH}`],
  ])("denies a push behind %s", async (_form, line) => {
    expect(await verdict(line)).toBe("deny");
  });

  // uutils env execs '!' as a program name and exits 127, so the push never runs (TP-3291).
  it("allows a -S string that starts with '!'", async () => {
    expect(await verdict(`env -S '! ${PUSH}'`)).toBe("pass");
  });

  it.each(["env -S 'echo hi'", "env -S '-u X echo hi'", "env -S '-i FOO=1 echo hi'", "env -S '-a sh echo hi'", "env -S \"echo '\\$G'\"", "env FOO=1 echo hi", "env FOO=1 -S 'echo hi'"])("allows %s", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

describe("env's leading words are read in one pass", () => {
  // Linear growth costs SCALE x the small case, quadratic SCALE^2 x; the bound sits between with headroom for load.
  const SCALE = 8;
  const MAX_RATIO = 24;
  const ROUNDS = 5;
  const largeBytes = 64 * 1024 - 32;

  // This thread's CPU time, not wall time: under a parallel run the scheduler preempts the long case more often than
  // the short one, which inflated a wall-clock ratio past the bound (TP-3612).
  async function cpuMs(script: string): Promise<number> {
    const readScript = (p: string) => (p === `${REPO}/p.sh` ? script : null);
    const started = process.threadCpuUsage();
    await verdict("bash ./p.sh", { ...context, readScript });
    const used = process.threadCpuUsage(started);
    return (used.user + used.system) / 1000;
  }

  // Interleaved so a burst of load lands on both sizes rather than only the one measured during it.
  async function growth(small: string, large: string): Promise<{ small: number; large: number }> {
    const best = { small: Infinity, large: Infinity };
    for (let round = 0; round < ROUNDS; round++) {
      best.small = Math.min(best.small, await cpuMs(small));
      best.large = Math.min(best.large, await cpuMs(large));
    }
    return best;
  }

  const envLine = (unit: string, bytes: number) => `env ${unit.repeat(Math.floor(bytes / unit.length))}true\n`;

  it.each([["A=1 - "], ["-- "], ["-S "], ["A=1 -i "], ["A=1 -S '' "]])("reads a script of env %j words in linear time", async (unit) => {
    const { small, large } = await growth(envLine(unit, largeBytes / SCALE), envLine(unit, largeBytes));

    expect(large).toBeLessThan(Math.max(small, 5) * MAX_RATIO);
  }, 60_000);

  const splitLine = (unit: string, bytes: number) => `env -S '${unit.repeat(Math.floor(bytes / unit.length))}true'\n`;

  it.each([
    ["env -S 'env env …'", splitLine, "env "],
    ["env -S env -S env -S …", envLine, "-S env "],
  ] as const)("reads a chain of envs a -S string supplies, %s, in linear time (TP-3291)", async (_form, line, unit) => {
    const { small, large } = await growth(line(unit, largeBytes / SCALE), line(unit, largeBytes));

    expect(large).toBeLessThan(Math.max(small, 5) * MAX_RATIO);
  }, 60_000);
});

const envSplits = spawnSync("env", ["-S", "-u X true"]).status === 0;
const envArgv0 = spawnSync("env", ["-S", "-a x true"]).status === 0;
const zsh = spawnSync("zsh", ["-f", "-c", "true"]).status === 0;

describe.skipIf(!envSplits)("env runs the command after its own -S options (TP-3210)", () => {
  function runs(split: string): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-split-"));
    try {
      spawnSync("env", ["-S", split], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
      return fs.existsSync(path.join(dir, "mk"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("runs the command after -u X", () => {
    expect(runs("-u X touch mk")).toBe(true);
  });

  it("runs the command after -i", () => {
    expect(runs("-i /usr/bin/env touch mk")).toBe(true);
  });

  it.skipIf(!envArgv0 || !zsh).each([`-a "sh"`, `-a 'sh'`, `-a s"h"`, "-a sh"])("runs zsh as sh behind %s (GNU, uutils)", (argv0) => {
    expect(runs(`${argv0} zsh -f -c "[[ -o shwordsplit ]] && touch mk"`)).toBe(true);
  });
});
