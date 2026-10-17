import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLoginState, readUsage } from "./index.js";

const roots: string[] = [];
const now = 1_800_000_000;
async function home() {
  const codeHome = await mkdtemp(join(tmpdir(), "openai-account-"));
  roots.push(codeHome);
  return { codeHome, label: "reporter" };
}
function quota(at = now, weekly = 20) {
  return JSON.stringify({ type: "event_msg", timestamp: new Date(at * 1000).toISOString(), payload: {
    type: "token_count", rate_limits: {
      primary: { used_percent: 10, window_minutes: 300, resets_at: now + 5000 },
      secondary: { used_percent: weekly, window_minutes: 10080, resets_at: now + 6000 },
    },
  } });
}
async function rollout(codeHome: string, name: string, contents: string, archived = false) {
  const dir = join(codeHome, archived ? "archived_sessions" : "sessions", "2026", "10", "17");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `rollout-${name}.jsonl`);
  await writeFile(file, contents);
  return file;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("Codex account node readers", () => {
  it("probes only login status with explicit home and no API fallback", async () => {
    const profile = await home();
    await writeFile(join(profile.codeHome, "auth.json"), "must not be read or changed");
    const state = await readLoginState(profile, { env: { PATH: "/test/bin", CODEX_HOME: "/wrong", OPENAI_API_KEY: "secret", CODEX_API_KEY: "secret", OPENAI_ACCESS_TOKEN: "secret" },
      runStatus: async input => {
        expect(input.args).toEqual(["login", "status"]);
        expect(input.executablePath).toBe("codex");
        expect(input.env).toEqual({ PATH: "/test/bin", CODEX_HOME: profile.codeHome });
        expect(input.timeoutMs).toBe(5000);
        return { exitCode: 0, stdout: "", stderr: "Logged in using ChatGPT" };
      } });
    expect(state.status).toBe("present");
    expect(await readFile(join(profile.codeHome, "auth.json"), "utf8")).toBe("must not be read or changed");
  });
  it("returns a fixed failure without the probe error or its cause", async () => {
    const state = await readLoginState(await home(), { runStatus: async () => { throw new Error("sk-proj-private"); } });
    expect(state).toEqual({ status: "refused", reason: "probe-failed" });
  });
  it.each([0, 1, 2])("handles native probe exit %s without invoking installed Codex", async exitCode => {
    const profile = await home();
    const executablePath = join(profile.codeHome, "fake-cli");
    const output = exitCode === 0 ? "Logged in using ChatGPT" : "Not logged in";
    await writeFile(executablePath, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== 'login status') process.exit(99);\nconsole.error(${JSON.stringify(output)}); process.exit(${exitCode});\n`, { mode: 0o700 });
    const state = await readLoginState(profile, { executablePath });
    expect(state.status).toBe(exitCode === 0 ? "present" : exitCode === 1 ? "missing" : "refused");
  });
  it("kills an overlong model-free probe and refuses an already aborted probe", async () => {
    const profile = await home();
    const executablePath = join(profile.codeHome, "fake-cli");
    await writeFile(executablePath, `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`, { mode: 0o700 });
    expect(await readLoginState(profile, { executablePath, timeoutMs: 30 }))
      .toEqual({ status: "refused", reason: "probe-failed" });
    const controller = new AbortController(); controller.abort();
    expect(await readLoginState(profile, { executablePath, signal: controller.signal }))
      .toEqual({ status: "refused", reason: "probe-failed" });
  });
  it("refuses a relative home rather than using the default account", async () => {
    await expect(readLoginState({ codeHome: "relative", label: "test" })).rejects.toThrow(/absolute/);
  });
  it("reads fixture rollouts across active and archived trees, using event time", async () => {
    const profile = await home();
    await rollout(profile.codeHome, "old", quota(now - 10));
    const newest = await rollout(profile.codeHome, "new", `${JSON.stringify({ type: "response_item", payload: "private" })}\n${quota(now, 87)}\n`, true);
    const before = await readFile(newest, "utf8");
    const result = await readUsage(profile);
    expect(result).toMatchObject({ status: "known", reading: { account: "reporter", written_at: now, rate_limits: { seven_day: { used_percentage: 87 } } } });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(await readFile(newest, "utf8")).toBe(before);
  });
  it("does not read auth.json or non-rollout files", async () => {
    const profile = await home();
    await writeFile(join(profile.codeHome, "auth.json"), "secret-not-json");
    await mkdir(join(profile.codeHome, "sessions"));
    await writeFile(join(profile.codeHome, "sessions", "auth.json"), "secret-not-json");
    expect(await readUsage(profile)).toEqual({ status: "unknown", reason: "missing" });
  });
  it("fails closed on malformed or partially appended JSON instead of falling back", async () => {
    const profile = await home();
    await rollout(profile.codeHome, "partial", `${quota()}\n{"payload":"secret"`);
    expect(await readUsage(profile)).toEqual({ status: "unknown", reason: "unreadable" });
  });
  it("refuses symlinked rollout files and directories", async () => {
    const profile = await home();
    const outside = await home();
    await writeFile(join(outside.codeHome, "private.jsonl"), quota());
    await mkdir(join(profile.codeHome, "sessions"));
    await symlink(join(outside.codeHome, "private.jsonl"), join(profile.codeHome, "sessions", "rollout-link.jsonl"));
    expect(await readUsage(profile)).toEqual({ status: "unknown", reason: "unreadable" });
    await rm(join(profile.codeHome, "sessions"), { recursive: true });
    await symlink(outside.codeHome, join(profile.codeHome, "sessions"));
    expect(await readUsage(profile)).toEqual({ status: "unknown", reason: "unreadable" });
  });
  it("has bounded file reads", async () => {
    const profile = await home();
    await rollout(profile.codeHome, "too-big", quota());
    expect(await readUsage(profile, { maxBytes: 10 })).toEqual({ status: "unknown", reason: "unreadable" });
  });
});
