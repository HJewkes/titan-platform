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

  it("rejects when command does not exist", async () => {
    await expect(
      runTool("nonexistent-command-xyz", []),
    ).rejects.toThrow(/Failed to spawn/);
  });
});
