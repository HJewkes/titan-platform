import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const PUSH = "git push origin HEAD:main\n";
const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-guard-operand-feed-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The hook's own stdin is a pipe, which no shell script is read from; a regular file there is what lets main read the operand and pass the line. */
const STDIN_AS_FILE = new Set(["/dev/stdin", "/dev/fd/0", join(home, "stdin"), join(home, "link")]);
const base = nodeContext(home);
const context = { ...base, readScript: (p: string) => (STDIN_AS_FILE.has(p) ? "echo event\n" : base.readScript(p)) };
const port: HookPort = { context, now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

function put(name: string, text: string | Buffer): string {
  writeFileSync(join(home, name), text);
  return join(home, name);
}

async function decision(command: string): Promise<string | null> {
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  const { stdout } = await handle(event, {}, port);
  return stdout === "" ? null : /"permissionDecision":"(\w+)"/.exec(stdout)?.[1] ?? "unknown";
}

const evil = put("evil.sh", PUSH);
const SHELLS = ["bash", "zsh", "dash"].filter((s) => existsSync(`/usr/bin/${s}`) || existsSync(`/bin/${s}`));

/** A fake git first on PATH records its run, so a real shell shows what the line does. */
function runsPush(line: string, shell: string): boolean {
  const bin = join(home, "fakebin");
  mkdirSync(bin, { recursive: true });
  const log = join(home, "git.log");
  rmSync(log, { force: true });
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> "${log}"\n`);
  chmodSync(join(bin, "git"), 0o755);
  spawnSync(shell, ["-c", line], { cwd: home, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore" });
  return existsSync(log) && readFileSync(log, "utf8").includes("push");
}

describe("a shell with a literal script operand and a file feed on stdin", () => {
  it.each(SHELLS)("denies %s reading evil.sh through /dev/stdin named as a relative path", async (shell) => {
    const line = `cd /dev && ${shell} stdin < ${evil}`;
    expect(runsPush(line, "bash")).toBe(true);
    expect(await decision(line)).toBe("deny");
  });

  it("denies a shell reading evil.sh through fd/0", async () => {
    expect(await decision(`cd /dev && sh fd/0 < ${evil}`)).toBe("deny");
  });

  it("denies a symlink to /dev/stdin made on the same line", async () => {
    const line = `ln -s /dev/stdin ${join(home, "stdin")} && bash ./stdin < ${evil}`;
    expect(await decision(line)).toBe("deny");
  });

  it("denies a symlink to /dev/stdin that is already there", async () => {
    symlinkSync("/dev/stdin", join(home, "link"));
    expect(await decision(`bash link < ${evil}`)).toBe("deny");
  });

  it("allows a regular file the line relinks to /dev/stdin, which the guard cannot see yet", async () => {
    put("existing.sh", "echo existing\n");
    expect(await decision(`ln -sf /dev/stdin ${join(home, "existing.sh")} && bash existing.sh < ${evil}`)).toBeNull();
  });
});

describe("a shell with a literal script operand and a data feed on stdin", () => {
  it("allows benign text", async () => {
    put("build.sh", "echo build\n");
    put("input.txt", "alpha\nbeta\n");
    expect(await decision("bash build.sh < input.txt")).toBeNull();
  });

  it("allows a data file larger than the script cap", async () => {
    put("import.sh", "echo import\n");
    put("big.csv", `${"a,b,c\n".repeat(20000)}`);
    expect(await decision("bash import.sh < big.csv")).toBeNull();
  });

  it("allows a script and a data file that together pass the budget", async () => {
    put("mid.sh", `${"# pad\n".repeat(5000)}echo mid\n`);
    put("mid.csv", "a,b,c\n".repeat(7000));
    expect(await decision("bash mid.sh < mid.csv")).toBeNull();
  });

  it("allows a binary data file", async () => {
    put("import.sh", "echo import\n");
    put("data.bin", Buffer.from([0, 1, 2, 0xff, 0xfe, 0, 7, 0x80]));
    expect(await decision("bash import.sh < data.bin")).toBeNull();
  });

  it("allows a data file that is missing", async () => {
    put("import.sh", "echo import\n");
    expect(await decision("bash import.sh < no-such-data.csv")).toBeNull();
  });

  it("allows /dev/null", async () => {
    put("build.sh", "echo build\n");
    expect(await decision("bash build.sh < /dev/null")).toBeNull();
  });

  it("allows a named descriptor's file when the operand is a regular file", async () => {
    put("ok.sh", "echo ok\n");
    put("{fd}", "echo ok\n");
    expect(await decision(`bash {fd}< ${evil} ./ok.sh`)).toBeNull();
  });

  it("allows -s with a benign file feed", async () => {
    put("setup.sh", "echo setup\n");
    expect(await decision("bash -s < setup.sh")).toBeNull();
  });

  it("allows a link to a regular file when its feed is benign", async () => {
    put("setup.sh", "echo setup\n");
    symlinkSync(join(home, "setup.sh"), join(home, "plain"));
    expect(await decision("bash plain < input.txt")).toBeNull();
  });
});
