import { describe, it, expect } from "vitest";
import { runTool } from "./tool-runner.js";

describe("runTool", () => {
  it("captures stdout from a successful command", async () => {
    const result = await runTool("echo", ["hello"]);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr from a command", async () => {
    const result = await runTool("node", ["-e", "console.error('oops')"]);
    expect(result.stderr.trim()).toBe("oops");
  });

  it("reports non-zero exit code", async () => {
    const result = await runTool("node", ["-e", "process.exit(2)"]);
    expect(result.exitCode).toBe(2);
  });

  it("reports a child killed by a signal with a null exit code, never as exit 0", async () => {
    const result = await runTool("node", ["-e", "process.kill(process.pid, 'SIGKILL')"]);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    expect(result.timedOut).toBe(false);
  });

  it("kills a child that outlives its timeout and says so", async () => {
    const result = await runTool("node", ["-e", "setTimeout(() => {}, 10_000)"], { timeout: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("rejects when command does not exist", async () => {
    await expect(
      runTool("nonexistent-command-xyz", []),
    ).rejects.toThrow(/Failed to spawn/);
  });
});
