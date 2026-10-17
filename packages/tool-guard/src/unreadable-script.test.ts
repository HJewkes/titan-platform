import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const PUSH = "git push origin HEAD:main";
const CAP = 64 * 1024;
const pad = (bytes: number) => `${"#".repeat(bytes - 1)}\n`;

/** A real directory, as the shell sees it: `fifo`, mode 000 `unreadable` and `big.sh` hold the push where the guard cannot read it. */
const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-guard-unreadable-")));
afterAll(() => {
  chmodSync(join(home, "unreadable"), 0o600);
  rmSync(home, { recursive: true, force: true });
});
spawnSync("mkfifo", [join(home, "fifo")]);
writeFileSync(join(home, "unreadable"), `${PUSH}\n`);
chmodSync(join(home, "unreadable"), 0);
mkdirSync(join(home, "dir"));
writeFileSync(join(home, "big.sh"), `${pad(CAP + 400)}${PUSH}\n`);
writeFileSync(join(home, "big.py"), `${pad(CAP + 400)}print("hi")\n`);
/** The push's last byte is the first one past the cap, so a read that stops at the cap sees a push to `mai`. */
writeFileSync(join(home, "edge.sh"), `${pad(CAP + 1 - PUSH.length)}${PUSH}`);
writeFileSync(join(home, "full-push.sh"), `${pad(CAP - PUSH.length)}${PUSH}`);
writeFileSync(join(home, "full.sh"), `${pad(CAP - 8)}echo hi\n`);

const port: HookPort = { context: nodeContext(home), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

async function verdict(command: string): Promise<{ decision: string | null; spelling: string | undefined; stdout: string }> {
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  const { stdout, log } = await handle(event, {}, port);
  const decision = stdout === "" ? null : (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
  return { decision, spelling: log[0]?.split("\t")[4], stdout };
}

describe("a shell running a file the guard cannot read in full", () => {
  it.each([
    ["a FIFO on stdin", "bash < ./fifo"],
    ["a FIFO zsh runs by path", "zsh -f ./fifo"],
    ["a directory", "bash ./dir"],
    ["a missing file", "bash ./missing.sh"],
    ["a missing file sourced", ". ./missing.sh"],
    ["a script with the push past the cap", "bash ./big.sh"],
    ["a script with the push past the cap on stdin", "bash < ./big.sh"],
    ["a script with the push past the cap that dash runs", "dash ./big.sh"],
    ["a script whose push ends one byte past the cap", "bash ./edge.sh"],
  ])("denies %s: %s", async (_, command) => {
    const { decision, spelling, stdout } = await verdict(command);

    expect(decision).toBe("deny");
    expect(spelling).toBe("bash.oversize");
    expect(stdout).toMatch(/cannot read in full/);
  });

  it.skipIf(process.getuid?.() === 0)("denies a mode 000 file a shell runs as /dev/stdin", async () => {
    expect((await verdict("bash /dev/stdin < ./unreadable")).decision).toBe("deny");
  });

  it("reads a script of exactly the cap in full and denies its push", async () => {
    expect((await verdict("bash ./full-push.sh")).spelling).toBe("bash.merge.git-push-protected");
  });

  it.each([
    ["a harmless script of exactly the cap", "bash ./full.sh"],
    ["an interpreter's script past the cap", "python3 ./big.py"],
    ["a script the line writes before it runs it", "echo 'echo hi' > ./new.sh; bash ./new.sh"],
    ["a FIFO only cat reads", "cat < ./fifo > /dev/null"],
  ])("passes %s", async (_, command) => {
    expect((await verdict(command)).decision).toBeNull();
  });
});
