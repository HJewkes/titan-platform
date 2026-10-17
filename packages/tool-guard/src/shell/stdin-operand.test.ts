import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";

const PUSH = "git push --no-verify origin HEAD:main";
const SHELLS = ["bash", "zsh", "dash", "sh"].filter((s) => spawnSync(s, ["-c", "true"]).status === 0);

/** A real directory the hook reads from: `real.sh` is an ordinary script the guard finds harmless when it looks. */
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "stdin-operand-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "real.sh"), "echo hi\n");
writeFileSync(join(dir, "other.sh"), "echo hi\n");
writeFileSync(join(dir, "build.sh"), "echo build\n");
writeFileSync(join(dir, "x.sh"), "echo x\n");
writeFileSync(join(dir, "t.zsh"), "echo t\n");
mkdirSync(join(dir, "pkg"));
writeFileSync(join(dir, "pkg", "build.sh"), "echo build\n");
mkdirSync(join(dir, "scripts"));
for (const name of ["a.sh", "note.sh", "changeset.sh"]) writeFileSync(join(dir, "scripts", name), "echo a\n");
for (const name of ["post.sh", "ask.sh"]) writeFileSync(join(dir, name), "echo a\n");

const port: HookPort = { context: nodeContext(dir), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

async function decision(command: string): Promise<string | null> {
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: dir, tool_input: { command } });
  const { stdout } = await handle(event, {}, port);
  return stdout === "" ? null : (/"permissionDecision":"(\w+)"/.exec(stdout)?.[1] ?? "unknown");
}

/**
 * Runs `line` under `shell` in a scratch dir whose `real.sh` holds `echo hi`, with a fake `git` first on PATH that
 * leaves a marker, and reports whether the push ran. `script` takes the place of `-c`'s string so a `cd` stays inside it.
 */
function pushRuns(shell: string, line: string): boolean {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "stdin-operand-run-")));
  try {
    mkdirSync(join(scratch, "bin"));
    writeFileSync(join(scratch, "bin", "git"), `#!/bin/sh\ntouch '${join(scratch, "mk")}'\n`);
    chmodSync(join(scratch, "bin", "git"), 0o755);
    writeFileSync(join(scratch, "real.sh"), "echo hi\n");
    writeFileSync(join(scratch, "line.sh"), `${line}\n`);
    const env = { ...process.env, ZDOTDIR: scratch, PATH: `${join(scratch, "bin")}:${process.env.PATH ?? ""}` };
    spawnSync(shell, ["line.sh"], { cwd: scratch, env, stdio: "ignore", timeout: 10_000 });
    return existsSync(join(scratch, "mk"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Feeds PUSH on stdin through a pipe, which every shell here takes; bash and zsh also take a here-string. */
const FED = (inner: string): string => `printf '%s\\n' '${PUSH}' | ${inner}`;

describe.each(SHELLS)("a %s script operand that is really stdin runs the push (premise for the rows below)", (shell) => {
  it("runs the push when `ln -sf /dev/stdin` replaces an existing file", () => {
    expect(pushRuns(shell, FED(`{ ln -sf /dev/stdin real.sh; ${shell} real.sh; }`))).toBe(true);
  });

  it("runs the push under a cwd that makes the operand stdin", () => {
    expect(pushRuns(shell, FED(`{ cd /dev && ${shell} stdin; }`))).toBe(true);
  });

  it("runs the push under a cwd the line cannot show", () => {
    expect(pushRuns(shell, FED(`{ D=/dev; cd "$D" && ${shell} stdin; }`))).toBe(true);
  });

  it("runs the stdin script of an ordinary operand never, as the control", () => {
    expect(pushRuns(shell, FED(`${shell} real.sh`))).toBe(false);
  });
});

describe("the hook denies a shell whose script operand may be its stdin", () => {
  const HERE = `<<< '${PUSH}'`;
  const LIVE_ON_MAIN: Array<[string, string]> = [
    ["a symlink to stdin replaces a file, after `;`", `ln -sf /dev/stdin real.sh; bash real.sh ${HERE}`],
    ["a symlink to stdin replaces a file, after `&&`", `ln -sf /dev/stdin real.sh && bash real.sh ${HERE}`],
    ["a symlink to stdin replaces a file, ./operand", `ln -sf /dev/stdin ./real.sh; bash ./real.sh ${HERE}`],
    ["a file is moved over the operand", `mv other.sh real.sh; bash real.sh ${HERE}`],
    ["a symlink to stdin replaces a file, absolute operand", `ln -sf /dev/stdin ${"@DIR@"}/real.sh; bash ${"@DIR@"}/real.sh ${HERE}`],
    ["the cwd is a run-time word", `cd "$D" && bash stdin ${HERE}`],
    ["the cwd is the previous one", `cd - && bash stdin ${HERE}`],
    ["the cwd is a substitution", `cd $(echo /dev) && bash stdin ${HERE}`],
    ["the operand follows --", `bash -- foo ${HERE}`],
    ["the shell is zsh", `ln -sf /dev/stdin real.sh; zsh real.sh ${HERE}`],
    ["the text is piped", `ln -sf /dev/stdin real.sh; echo '${PUSH}' | bash real.sh`],
    ["the text is a heredoc", `cd "$D" && sh stdin <<'EOF'\n${PUSH}\nEOF`],
    ["the stdin is inherited from an outer shell", `ln -sf /dev/stdin real.sh; bash -c 'bash real.sh' ${HERE}`],
  ];

  it.each(LIVE_ON_MAIN)("denies when %s", async (_why, line) => {
    expect(await decision(line.replaceAll("@DIR@", dir))).toBe("deny");
  });

  /** These deny on main too, only because the guard cannot read `/dev/stdin` or a name that is not there yet: kept so that stays true for the right reason. */
  const ACCIDENTAL: Array<[string, string]> = [
    ["cd /dev", `cd /dev && bash stdin ${HERE}`],
    ["cd /proc/self/fd", `cd /proc/self/fd && zsh 0 ${HERE}`],
    ["a fresh symlink", `ln -s /dev/stdin s; bash s ${HERE}`],
    ["a fresh absolute symlink", `ln -s /dev/stdin ${"@DIR@"}/fresh; bash ${"@DIR@"}/fresh ${HERE}`],
  ];

  it.each(ACCIDENTAL)("still denies (unreadable or missing operand) for %s", async (_form, line) => {
    expect(await decision(line.replaceAll("@DIR@", dir))).toBe("deny");
  });

  it("denies a shell with no operand that reads the same text, the control", async () => {
    expect(await decision(`bash ${HERE}`)).toBe("deny");
  });
});

describe("the hook still allows an ordinary script operand", () => {
  it.each([
    "bash real.sh",
    "bash build.sh",
    "sh ./x.sh",
    "cd pkg && bash build.sh",
    "zsh -f t.zsh",
    "bash scripts/a.sh",
    "bash real.sh <<< 'echo hi'",
    "echo y | bash real.sh",
    `bash -c 'echo hi' real.sh <<< 'echo hi'`,
  ])("allows %s", async (line) => {
    expect(await decision(line)).toBeNull();
  });

  it("allows a run-time cwd with no text on stdin", async () => {
    expect(await decision(`cd "$D" && bash build.sh`)).toBeNull();
  });

  it("does not read stdin text as a script under -c", async () => {
    expect(await decision(`bash -c 'echo hi' x.sh <<< '${PUSH}'`)).toBeNull();
  });
});

describe("stdin text that is data for a literal operand, not a script", () => {
  it.each([
    `bash x.sh <<< "it's fine"`,
    "bash ./scripts/note.sh <<EOF\nDon't merge yet\nEOF",
    "bash ./scripts/changeset.sh <<'EOF'\nFix the parser's handling of quotes\nEOF",
    `echo "Don't merge yet" | bash ./scripts/note.sh`,
    `printf '%s\n' "it's done" | bash post.sh`,
    "bash ./ask.sh <<< 'yes (default)'",
    "bash x.sh <<< 'please confirm: (y/n)'",
    "bash x.sh <<'EOF'\n- it's two\nEOF",
  ])("allows %j", async (line) => {
    expect(await decision(line)).toBeNull();
  });

  const MAIN = "git push origin main";
  it.each([
    ["a here-string", `bash x.sh <<< $'${MAIN}\\n\\'x'`],
    ["a heredoc", `bash x.sh <<'EOF'\n${MAIN}\n'\nEOF`],
    ["a literal pipe", `printf '%s\\n' '${MAIN}' "'" | bash x.sh`],
    ["a push between two commands", `bash x.sh <<'EOF'\necho hi\n${MAIN}\nit's\nEOF`],
    ["a push split over a continuation line", `bash x.sh <<'EOF'\ngit push \\\norigin main\n'\nEOF`],
  ])("denies a push before a stray quote in %s", async (_how, line) => {
    expect(await decision(line)).toBe("deny");
  });

  it("keeps refusing text it cannot parse when the shell has no operand", async () => {
    expect(await decision(`bash <<< "it's fine"`)).toBe("deny");
  });
});

describe("stdin text read for a literal operand is charged to the script budget", () => {
  it("refuses or reads a 64KB here-string under an operand without timing out", async () => {
    const started = Date.now();
    const big = `${"#".repeat(64 * 1024)}\n${PUSH}`;

    const verdict = await decision(`bash real.sh <<< '${big}'`);

    expect(verdict).toBe("deny");
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
