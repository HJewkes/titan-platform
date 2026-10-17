import { mkdtemp, writeFile, chmod, symlink, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeQuotaWorkspace, inspectNativeVersion, nativeEnvironment, resolveNativeExecutable } from "./native-process.js";

const runner = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: runner.exec }));
const roots: string[] = [];
afterEach(async () => { runner.exec.mockReset(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("native quota executable policy", () => {
  it("creates and cleans only its own empty temporary workspace", async () => {
    const workspace = await createNativeQuotaWorkspace(); roots.push(workspace.cwd);
    expect(await readdir(workspace.cwd)).toEqual([]); await workspace.dispose();
    await expect(stat(workspace.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("resolves an explicit executable symlink to a single absolute realpath without running it", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-executable-")); roots.push(root);
    const target = join(root, "installed-cli"); const link = join(root, "codex");
    await writeFile(target, "fixture-never-executed", { mode: 0o700 }); await symlink(target, link);
    expect(await resolveNativeExecutable("codex", { PATH: ["", ".", root].join(delimiter) })).toBe(target);
    expect(await resolveNativeExecutable(link, {})).toBe(target);
    await chmod(target, 0o600);
    await expect(resolveNativeExecutable(link, {})).rejects.toThrow("native quota executable unavailable");
  });
  it("does not search relative or empty PATH entries or accept relative executable paths", async () => {
    for (const executable of ["codex", "./codex", "../codex", "other-cli"]) {
      await expect(resolveNativeExecutable(executable, { PATH: ["", ".", "relative"].join(delimiter) })).rejects.toThrow("native quota executable unavailable");
    }
  });
  it("allowlists native environment and strips provider, startup injection and account overrides", () => {
    const env = nativeEnvironment({ label: "fixture", codeHome: "/fixture/home" }, { PATH: "/fixture/bin", HOME: "/fixture/user",
      CODEX_HOME: "/wrong", OPENAI_BASE_URL: "https://other.invalid", OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret",
      CLAUDE_CONFIG_DIR: "/wrong", AGENT_CHAT_SOCKET: "/wrong", NODE_OPTIONS: "secret", LD_PRELOAD: "secret", BASH_ENV: "/wrong" });
    expect(env).toEqual({ PATH: "/fixture/bin", HOME: "/fixture/user", CODEX_HOME: "/fixture/home" });
  });
  it("probes only version with bounded output and the same resolved executable", async () => {
    const signal = new AbortController().signal;
    runner.exec.mockImplementation((_exe: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => callback(null, "codex-cli 0.162.1"));
    expect(await inspectNativeVersion({ executablePath: "/fixture/bin/codex", cwd: "/fixture/empty-workspace", env: { CODEX_HOME: "/fixture/home" }, signal })).toBe("codex-cli 0.162.1");
    expect(runner.exec).toHaveBeenCalledWith("/fixture/bin/codex", ["--version"], {
      cwd: "/fixture/empty-workspace", env: { CODEX_HOME: "/fixture/home" }, signal, encoding: "utf8", maxBuffer: 4096, killSignal: "SIGKILL" }, expect.any(Function));
  });
  it("never returns a native version error or stdout body", async () => {
    runner.exec.mockImplementation((_exe: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => callback(new Error("private-secret"), "private-secret"));
    await expect(inspectNativeVersion({ executablePath: "/fixture/bin/codex", cwd: "/fixture/empty-workspace", env: {}, signal: new AbortController().signal })).rejects.toThrow("native quota version failed");
  });
});
