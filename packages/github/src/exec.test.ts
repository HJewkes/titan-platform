import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execGh } from "./exec.js";

const MARKER = "tp564-fake-gh-sleeper";
const dirs: string[] = [];
const savedPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = savedPath;
  try {
    execFileSync("pkill", ["-KILL", "-f", MARKER]);
  } catch {
    // pkill exits 1 when nothing matched
  }
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function pgrepCount(): number {
  try {
    return execFileSync("pgrep", ["-f", MARKER], { encoding: "utf8" }).trim().split("\n").length;
  } catch {
    return 0;
  }
}

/** Puts a `gh` on PATH that sleeps far longer than any test waits; the marker in its directory name lets pgrep find it. */
function installHungGh(): void {
  const dir = mkdtempSync(join(tmpdir(), `${MARKER}-`));
  dirs.push(dir);
  const script = join(dir, "gh");
  writeFileSync(script, `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nsetTimeout(() => undefined, 60000);\n`);
  chmodSync(script, 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
}

describe("execGh timeoutMs", () => {
  it("rejects and leaves no gh child alive when the timeout passes", async () => {
    installHungGh();

    await expect(execGh(["api", "rate_limit"], undefined, { timeoutMs: 300 })).rejects.toThrow(/timed out after 300 ms/);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pgrepCount()).toBe(0);
  });

  it("rejects with an output-limit error, not a timeout, when output overflows maxBufferBytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-gh-"));
    dirs.push(dir);
    writeFileSync(join(dir, "gh"), `#!${process.execPath}\nprocess.stdout.write("x".repeat(4096));\n`);
    chmodSync(join(dir, "gh"), 0o755);
    process.env.PATH = `${dir}:${savedPath}`;

    const run = execGh(["api", "big"], undefined, { timeoutMs: 5_000, maxBufferBytes: 64 });

    await expect(run).rejects.toThrow(/output exceeded 64 bytes/);
    await expect(run).rejects.not.toThrow(/timed out/);
  });

  it("keeps the child running when no timeout is given", async () => {
    installHungGh();
    const pending = execGh(["api", "rate_limit"]);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(pgrepCount()).toBeGreaterThan(0);
    execFileSync("pkill", ["-KILL", "-f", MARKER]);
    expect((await pending).code).not.toBe(0);
  });

  it("resolves normally when gh finishes inside the timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-gh-"));
    dirs.push(dir);
    writeFileSync(join(dir, "gh"), `#!${process.execPath}\nprocess.stdout.write("hi");\n`);
    chmodSync(join(dir, "gh"), 0o755);
    process.env.PATH = `${dir}:${savedPath}`;

    expect(await execGh([], undefined, { timeoutMs: 5_000 })).toEqual({ code: 0, stdout: "hi", stderr: "" });
  });
});
