import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@titan-design/fix-proof";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { ensureScratchClone } from "./scratch-clone.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function outDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scratch-clone-"));
  dirs.push(dir);
  return dir;
}

const exited = (status: number, stderr = ""): Mock<Exec> => vi.fn<Exec>(async () => ({ status, stdout: "", stderr }));
const ok = (): Mock<Exec> => exited(0);

describe("ensureScratchClone", () => {
  it("clones shared and without checkout into .scratch/<owner>/<repo>", async () => {
    const out = outDir();
    const exec = ok();
    const clone = await ensureScratchClone({ repo: "acme/widgets", outDir: out, exec, sourceOf: () => "/src/widgets" });
    expect(clone).toBe(join(out, ".scratch", "acme/widgets"));
    expect(exec).toHaveBeenCalledWith("git", ["clone", "--quiet", "--shared", "--no-checkout", "--", "/src/widgets", clone], expect.objectContaining({ cwd: join(out, ".scratch", "acme") }));
  });

  it("reuses an existing clone without resolving the source", async () => {
    const out = outDir();
    mkdirSync(join(out, ".scratch", "acme/widgets"), { recursive: true });
    const exec = ok();
    const sourceOf = vi.fn(() => "/src");
    await ensureScratchClone({ repo: "acme/widgets", outDir: out, exec, sourceOf });
    expect(exec).not.toHaveBeenCalled();
    expect(sourceOf).not.toHaveBeenCalled();
  });

  it.each(["widgets", "../evil/x", "a/b/c", "a/.."])("rejects %s as a repo name", async (repo) => {
    await expect(ensureScratchClone({ repo, outDir: outDir(), exec: ok(), sourceOf: () => "/src" })).rejects.toThrow("not owner/name");
  });

  it("reports a failed clone with its exit status", async () => {
    const exec = exited(128, "boom\n");
    await expect(ensureScratchClone({ repo: "acme/widgets", outDir: outDir(), exec, sourceOf: () => "/src" })).rejects.toThrow("exit 128): boom");
  });
});
