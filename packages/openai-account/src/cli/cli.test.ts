import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliContext } from "./cli.js";

const now = 1_800_000_000;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function context(env: CliContext["env"] = {}) {
  const out: string[] = [], err: string[] = [];
  return { env, now: () => now * 1000, out: (line: string) => { out.push(line); }, err: (line: string) => { err.push(line); }, output: out, errors: err };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-statusline-")); roots.push(root);
  const home = join(root, "reporter");
  await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(join(home, "auth.json"), "private-auth-never-read");
  await writeFile(join(home, "sessions", "rollout-test.jsonl"), JSON.stringify({ type: "event_msg", timestamp: new Date((now - 5) * 1000).toISOString(), payload: {
    type: "token_count", rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: now + 1000 },
      secondary: { used_percent: 30, window_minutes: 10080, resets_at: now + 2000 } },
  } }));
  return home;
}

describe("openai-account statusline command", () => {
  it("reads the explicit environment home through the slice B reader", async () => {
    const ctx = context({ CODEX_HOME: await fixture() });
    expect(await runCli(["status", "--statusline"], ctx)).toBe(0);
    expect(ctx.output).toEqual(["codex|reporter|10|30|5|"]);
    expect(ctx.errors).toEqual([]);
  });
  it("supports explicit home and account overrides without scanning a default account", async () => {
    const ctx = context({ CODEX_HOME: "/wrong" });
    expect(await runCli(["status", "--statusline", "--code-home", await fixture(), "--account", "basement"], ctx)).toBe(0);
    expect(ctx.output).toEqual(["codex|basement|10|30|5|"]);
  });
  it("prints one unknown line with no stderr or I/O when CODEX_HOME is absent", async () => {
    let calls = 0;
    const ctx = { ...context(), readUsage: async () => { calls++; throw new Error("must not be called"); } };
    expect(await runCli(["status", "--statusline"], ctx)).toBe(0);
    expect(ctx.output).toEqual(["codex|default|unknown|unknown||"]);
    expect(ctx.errors).toEqual([]);
    expect(calls).toBe(0);
  });
  it("drops reader exceptions and emits only a fixed unknown line", async () => {
    const ctx = { ...context({ CODEX_HOME: "/tmp/reporter" }), readUsage: async () => { throw new Error("sk-proj-privateToken"); } };
    expect(await runCli(["status", "--statusline"], ctx)).toBe(0);
    expect(ctx.output).toEqual(["codex|reporter|unknown|unknown||"]);
    expect(ctx.errors).toEqual([]);
  });
  it.each(["relative", "/tmp/bad|label", "/tmp/sk-proj-privateToken"])("keeps invalid selections quiet: %s", home => {
    const ctx = context({ CODEX_HOME: home });
    return runCli(["status", "--statusline"], ctx).then(code => {
      expect(code).toBe(0);
      expect(ctx.output[0]).toMatch(/^codex\|[A-Za-z0-9_.-]+\|unknown\|unknown\|\|$/);
      expect(ctx.output.join("")).not.toMatch(/privateToken|bad\|label/);
      expect(ctx.errors).toEqual([]);
    });
  });
  it("makes stale fixtures unknown without invoking a login probe", async () => {
    const ctx = context({ CODEX_HOME: await fixture() }); ctx.now = () => (now + 901) * 1000;
    expect(await runCli(["status", "--statusline"], ctx)).toBe(0);
    expect(ctx.output).toEqual(["codex|reporter|unknown|unknown||"]);
  });
  it.each([[], ["poll"], ["status"], ["status", "--statusline", "--statusline"],
    ["status", "--statusline", "--account"], ["status", "--statusline", "--secret=sk-proj-private"]].map(args => ({ args })))("rejects invalid syntax without echoing arguments: $args", async ({ args }) => {
    const ctx = context();
    expect(await runCli(args, ctx)).toBe(64);
    expect(ctx.output).toEqual([]);
    expect(ctx.errors.join("")).toContain("usage:");
    expect(ctx.errors.join("")).not.toContain("sk-proj-private");
  });
  it("documents its read-only command with --help", async () => {
    const ctx = context();
    expect(await runCli(["--help"], ctx)).toBe(0);
    expect(ctx.output.join("")).toContain("status --statusline");
    expect(ctx.errors).toEqual([]);
  });
});
