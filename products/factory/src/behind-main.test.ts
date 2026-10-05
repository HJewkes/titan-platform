import type { GhExec } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import { behindMain, BEHIND_MAIN_TTL_MS } from "./behind-main.js";

const ok = (stdout: string) => async () => ({ code: 0, stdout, stderr: "" });

describe("behindMain", () => {
  it("reports checking until the first probe resolves", async () => {
    const probe = behindMain({ sha: "abc", exec: ok("3\n") });

    expect(probe.status()).toBe("checking");
    await probe.refresh();

    expect(probe.status()).toBe(3);
  });

  it("compares the clean sha when the build was dirty", async () => {
    const exec = vi.fn<GhExec>(ok("0"));
    const probe = behindMain({ sha: "abc-dirty", exec });

    await probe.refresh();

    expect(exec.mock.calls[0]?.[0]).toContain("repos/HJewkes/titan-platform/compare/abc...main");
  });

  it("serves the cache for five minutes, then probes again", async () => {
    let clock = 0;
    const exec = vi.fn<GhExec>(ok("1"));
    const probe = behindMain({ sha: "abc", exec, now: () => clock });
    await probe.refresh();

    clock = BEHIND_MAIN_TTL_MS - 1;
    await probe.refresh();
    expect(exec).toHaveBeenCalledTimes(1);

    clock = BEHIND_MAIN_TTL_MS;
    await probe.refresh();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("reports a redacted error when gh fails", async () => {
    const exec: GhExec = async () => ({ code: 1, stdout: "", stderr: "bad token ghp_secret123" });
    const probe = behindMain({ sha: "abc", exec });

    await probe.refresh();

    expect(String(probe.status())).toContain("gh compare failed (1)");
    expect(String(probe.status())).not.toContain("ghp_secret123");
  });

  it("reports a thrown exec as an error without throwing", async () => {
    const probe = behindMain({ sha: "abc", exec: async () => Promise.reject(new Error("spawn gh ENOENT")) });

    await probe.refresh();

    expect(probe.status()).toBe("gh compare failed: spawn gh ENOENT");
  });

  it("reports unknown without calling gh when the build sha is unknown", () => {
    const exec = vi.fn<GhExec>(ok("1"));

    expect(behindMain({ sha: "unknown", exec }).status()).toBe("unknown");
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports unknown without calling gh when the factory repo is undefined", () => {
    const exec = vi.fn<GhExec>(ok("1"));

    expect(behindMain({ sha: "abc", repo: undefined, exec }).status()).toBe("unknown");
    expect(exec).not.toHaveBeenCalled();
  });

  it("compares against the repo it is given", async () => {
    const exec = vi.fn<GhExec>(ok("0"));

    await behindMain({ sha: "abc", repo: "acme/fork", exec }).refresh();

    expect(exec.mock.calls[0]?.[0]).toContain("repos/acme/fork/compare/abc...main");
  });
});
