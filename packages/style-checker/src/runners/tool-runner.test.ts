import { EventEmitter } from "node:events";
import { describe, it, expect, vi, afterEach } from "vitest";
import * as childProcess from "node:child_process";
import { runTool } from "./tool-runner.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

function fakeFailingChild(code: string): childProcess.ChildProcess {
  const child = new EventEmitter() as childProcess.ChildProcess;
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  setImmediate(() => child.emit("error", Object.assign(new Error(`spawn ${code}`), { code })));
  return child;
}

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

  describe("when the kernel refuses to exec a script another thread just wrote", () => {
    afterEach(() => {
      vi.mocked(childProcess.spawn).mockReset();
    });

    it("retries the spawn after ETXTBSY and returns the successful run", async () => {
      const real = (await vi.importActual<typeof childProcess>("node:child_process")).spawn;
      const spawnSpy = vi.mocked(childProcess.spawn);
      spawnSpy.mockClear();
      spawnSpy.mockImplementationOnce(() => fakeFailingChild("ETXTBSY"));
      spawnSpy.mockImplementation(real);

      const result = await runTool("echo", ["again"]);

      expect(result.stdout.trim()).toBe("again");
      expect(spawnSpy).toHaveBeenCalledTimes(2);
    });

    it("gives up with a spawn failure when ETXTBSY never clears", async () => {
      const spawnSpy = vi.mocked(childProcess.spawn);
      spawnSpy.mockClear();
      spawnSpy.mockImplementation(() => fakeFailingChild("ETXTBSY"));

      await expect(runTool("echo", [])).rejects.toThrow(/Failed to spawn echo: spawn ETXTBSY/);
      expect(spawnSpy.mock.calls.length).toBeGreaterThan(1);
    });

    it("does not retry other spawn errors", async () => {
      const spawnSpy = vi.mocked(childProcess.spawn);
      spawnSpy.mockClear();
      spawnSpy.mockImplementation(() => fakeFailingChild("ENOENT"));

      await expect(runTool("echo", [])).rejects.toThrow(/ENOENT/);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
