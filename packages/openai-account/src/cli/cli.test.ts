import { describe, expect, it, vi } from "vitest";
import { runCli, type CliContext } from "./cli.js";
import { knownObservation, type UsageResult } from "../usage.js";

const now = 1_800_000_000;
function context(env: CliContext["env"] = { CODEX_HOME: "/fixture/reporter" }) {
  const out: string[] = [], err: string[] = [];
  const result: UsageResult = knownObservation({ source: "synthetic-cli-independent-clock", observedAt: now - 5,
    reading: { account: "reporter",
      rate_limits: { five_hour: { used_percentage: 10, resets_at: now + 1000 }, seven_day: { used_percentage: 30, resets_at: now + 2000 } } },
  });
  const readNativeUsage = vi.fn(async (): Promise<UsageResult> => result);
  return { env, now: () => now * 1000, out: (line: string) => { out.push(line); }, err: (line: string) => { err.push(line); }, readNativeUsage, output: out, errors: err };
}
const bound = ["status", "--statusline", "--expected-account-id", "fixture-account"];

describe("openai-account authoritative statusline command", () => {
  it("passes the explicit home and caller identity to the authoritative native reader", async () => {
    const ctx = context({ CODEX_HOME: "/fixture/reporter", PATH: "/fixture/bin" });
    expect(await runCli(bound, ctx)).toBe(0);
    expect(ctx.readNativeUsage).toHaveBeenCalledWith({ codeHome: "/fixture/reporter", label: "reporter" },
      { expectedAccountId: "fixture-account", env: ctx.env });
    expect(ctx.output).toEqual(["codex|reporter|10|30|5|"]);
    expect(ctx.errors).toEqual([]);
    expect(ctx.output.join("")).not.toContain("fixture-account");
  });
  it("supports home and display-label overrides without changing the identity binding", async () => {
    const ctx = context({ CODEX_HOME: "/wrong" });
    ctx.readNativeUsage.mockResolvedValue({ status: "unknown", reason: "missing" });
    expect(await runCli([...bound, "--code-home", "/fixture/selected", "--account", "basement"], ctx)).toBe(0);
    expect(ctx.readNativeUsage).toHaveBeenCalledWith({ codeHome: "/fixture/selected", label: "basement" },
      { expectedAccountId: "fixture-account", env: ctx.env });
    expect(ctx.output).toEqual(["codex|basement|unknown|unknown||"]);
  });
  it.each([undefined, "", "bad|id", "line\nbreak", " ", "x".repeat(257)])("refuses missing or invalid binding before native launch: %s", async id => {
    const ctx = context();
    const { runStatusline } = await import("./statusline.js");
    await runStatusline({ expectedAccountId: id }, ctx);
    expect(ctx.readNativeUsage).not.toHaveBeenCalled();
    expect(ctx.output).toEqual(["codex|reporter|unknown|unknown||"]);
  });
  it("does not infer binding from environment, home or display label", async () => {
    const ctx = context({ CODEX_HOME: "/fixture/reporter", CODEX_ACCOUNT_ID: "fixture-account" });
    expect(await runCli(["status", "--statusline", "--account", "reporter"], ctx)).toBe(0);
    expect(ctx.readNativeUsage).not.toHaveBeenCalled();
    expect(ctx.output).toEqual(["codex|reporter|unknown|unknown||"]);
  });
  it("does not launch without an explicit absolute home", async () => {
    for (const env of [{}, { CODEX_HOME: "relative" }]) {
      const ctx = context(env); await runCli(bound, ctx);
      expect(ctx.readNativeUsage).not.toHaveBeenCalled();
      expect(ctx.output[0]).toContain("|unknown|unknown||");
    }
  });
  it.each(["/fixture/line\nbreak", "/fixture/tab\tpath", "/fixture/nul\0path"])("rejects control characters in explicit homes before launch", async home => {
    const ctx = context();
    await runCli([...bound, "--code-home", home, "--account", "reporter"], ctx);
    expect(ctx.readNativeUsage).not.toHaveBeenCalled();
    expect(ctx.output).toEqual(["codex|reporter|unknown|unknown||"]);
  });
  it("drops exceptions and identity mismatches without disclosing reader output", async () => {
    const ctx = context(); ctx.readNativeUsage.mockRejectedValue(new Error("sk-proj-privateToken"));
    expect(await runCli(bound, ctx)).toBe(0);
    expect(ctx.output).toEqual(["codex|reporter|unknown|unknown||"]); expect(ctx.errors).toEqual([]);
  });
  it.each(["freshness-unverified", "inconsistent", "unreadable"] as const)("keeps %s unknown", async reason => {
    const ctx = context(); ctx.readNativeUsage.mockResolvedValue({ status: "unknown", reason });
    await runCli(bound, ctx); expect(ctx.output).toEqual(["codex|reporter|unknown|unknown||"]);
  });
  it("checks age at display time including native request duration", async () => {
    const ctx = context(); ctx.now = () => (now + 901) * 1000;
    await runCli(bound, ctx); expect(ctx.output).toEqual(["codex|reporter|unknown|unknown||"]);
  });
  it.each([[], ["poll"], ["status"], ["status", "--statusline", "--statusline"],
    ["status", "--statusline", "--expected-account-id"], ["status", "--statusline", "--secret=private"]].map(args => ({ args })))("rejects syntax without echoing arguments: $args", async ({ args }) => {
    const ctx = context(); expect(await runCli(args, ctx)).toBe(64);
    expect(ctx.output).toEqual([]); expect(ctx.errors.join("")).toContain("usage:");
    expect(ctx.errors.join("")).not.toContain("--secret=private"); expect(ctx.readNativeUsage).not.toHaveBeenCalled();
  });
  it("documents explicit native opt-in and effects", async () => {
    const ctx = context(); expect(await runCli(["--help"], ctx)).toBe(0);
    expect(ctx.output.join("")).toContain("--expected-account-id");
    expect(ctx.output.join("")).toContain("credential refresh"); expect(ctx.readNativeUsage).not.toHaveBeenCalled();
  });
});
