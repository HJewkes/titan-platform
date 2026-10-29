import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runShellRows } from "./shell-rows.js";

const dir = mkdtempSync(join(tmpdir(), "shell-rows-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  // init reaps the killed child asynchronously; give it a moment before calling it a leak.
  for (let tries = 0; tries < 40 && alive(pid); tries++) await new Promise((done) => setTimeout(done, 50));
  return !alive(pid);
}

describe("runShellRows", () => {
  it("hands each row its argv, cwd, environment and stdin, and reads back its status and output", async () => {
    const rows = await runShellRows([
      { name: "echo", program: "sh", args: ["-c", 'printf "%s|%s|%s" "$0" "$(pwd)" "$V"; cat; echo e >&2; exit 3', "zero"], cwd: dir, env: { V: "v", PATH: process.env.PATH }, input: "in" },
      { name: "inherit", program: "sh", args: ["-c", 'printf %s "$W"'], cwd: dir, extraEnv: { W: "w" } },
    ]);

    expect(rows.of(0)).toEqual({ status: 3, stdout: `zero|${dir}|vin`, stderr: "e\n" });
    expect(rows.of(1).stdout).toBe("w");
  });

  it("kills a hung row, names it, and still runs the rows after it", async () => {
    const rows = await runShellRows(
      [
        { name: "hangs", program: "sh", args: ["-c", "sleep 30"], cwd: dir },
        { name: "after", program: "sh", args: ["-c", "echo ran"], cwd: dir },
      ],
      300,
    );

    expect(() => rows.of(0)).toThrow(/shell row "hangs" ran past 300 ms/);
    expect(rows.of(1).stdout).toBe("ran\n");
  });

  it("leaves nothing a row forked running after the row exits", async () => {
    await runShellRows([{ name: "forks", program: "sh", args: ["-c", "sleep 30 & echo $! > child.pid"], cwd: dir }]);

    expect(await gone(Number(readFileSync(join(dir, "child.pid"), "utf8")))).toBe(true);
  });
});
