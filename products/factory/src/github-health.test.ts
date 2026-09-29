import type { GhExec, GhResult } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import { githubHealth } from "./github-health.js";

const ok: GhResult = { code: 0, stdout: "{}", stderr: "" };

function clocked(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe("githubHealth", () => {
  it("reports ok once gh api rate_limit succeeds", async () => {
    const exec = vi.fn<GhExec>().mockResolvedValue(ok);
    const health = githubHealth({ exec });

    await health.refresh();

    expect(health.status()).toBe("ok");
    expect(exec).toHaveBeenCalledWith(["api", "rate_limit"]);
  });

  it("reports the gh error text, redacted, when gh fails", async () => {
    const stderr = "gh: HTTP 401 Bad credentials token ghp_abcdef123456";
    const health = githubHealth({ exec: async () => ({ code: 1, stdout: "", stderr }) });

    await health.refresh();

    expect(health.status()).toContain("HTTP 401 Bad credentials");
    expect(health.status()).not.toContain("ghp_abcdef123456");
  });

  it("reports the error when gh cannot be spawned", async () => {
    const health = githubHealth({ exec: () => Promise.reject(new Error("spawn gh ENOENT")) });

    await health.refresh();

    expect(health.status()).toContain("spawn gh ENOENT");
  });

  it("does not probe again inside the ttl, and probes again after it", async () => {
    const clock = clocked();
    const exec = vi.fn<GhExec>().mockResolvedValue(ok);
    const health = githubHealth({ exec, now: clock.now, ttlMs: 60_000 });
    await health.refresh();

    clock.advance(59_000);
    health.status();
    await health.refresh();
    expect(exec).toHaveBeenCalledTimes(1);

    clock.advance(1_000);
    await health.refresh();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("shares one probe among concurrent callers", async () => {
    const exec = vi.fn<GhExec>().mockResolvedValue(ok);
    const health = githubHealth({ exec });

    health.status();
    health.status();
    await health.refresh();

    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("answers checking without waiting for gh", () => {
    const health = githubHealth({ exec: () => new Promise<GhResult>(() => undefined) });

    expect(health.status()).toBe("checking");
  });

  it("times out a hung gh and reports it", async () => {
    vi.useFakeTimers();
    try {
      const health = githubHealth({ exec: () => new Promise<GhResult>(() => undefined), timeoutMs: 5_000 });
      const done = health.refresh();
      await vi.advanceTimersByTimeAsync(5_000);
      await done;

      expect(health.status()).toContain("timed out after 5000 ms");
    } finally {
      vi.useRealTimers();
    }
  });
});
