import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DAILY_FIXTURE, DAY, fakeGh, fixtureTasks, REPO } from "../presets/daily/daily-fakes.test-helpers.js";
import { runRunCli } from "./run-cli.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

function cli() {
  const out: string[] = [];
  const err: string[] = [];
  const gather = { gh: fakeGh(), listTasks: async () => fixtureTasks() };
  const host = fakeHost(fx, fakeScriptModel(), fakeBridge());
  const run = (...argv: string[]) => runRunCli(["run", ...argv, "--data-dir", fx.dataDir], { host, gather, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { run, out, err };
}

const DAILY = ["--facts-from", "gatherDaily", "--day", DAY, "--repo", REPO, "--transcripts", path.join(DAILY_FIXTURE, "transcripts"), "--initiative", "demo"];

describe("explainer run --facts-from gatherDaily", () => {
  it("dry run gathers the daily facts pack for daily-overview and stops before any stage", async () => {
    fx = fixture();
    cpSync(path.join(DAILY_FIXTURE, "snapshots"), path.join(fx.dataDir, "task-snapshots"), { recursive: true });
    const { run, out, err } = cli();

    const code = await run(...DAILY, "--type", "daily-overview", "--dry-run");
    const facts = path.join(fx.dataDir, "gather", "daily-overview", DAY, "facts.md");

    expect(code).toBe(0);
    expect(err.join("")).toBe("");
    expect(out.join("")).toContain(`gathered 10 facts for daily-overview ${DAY}: ${facts}`);
    expect(out.join("")).toContain(`dry run: would run script to export with facts ${facts}`);
    expect(readFileSync(facts, "utf8")).toContain("| task/DM-3/owner-gated | task owner-gated · demo · Pick a courier for overnight runs");
    expect(existsSync(path.join(fx.dataDir, "runs"))).toBe(false);
  });

  it("refuses a type whose profile does not take facts from gatherDaily", async () => {
    fx = fixture();
    const { run, err } = cli();

    expect(await run(...DAILY, "--type", "repo-tour", "--dry-run")).toBe(2);
    expect(err.join("")).toContain("type repo-tour takes facts from");
  });

  it("refuses --facts-from without --type, and alongside --facts", async () => {
    fx = fixture();
    const { run, err } = cli();

    expect(await run(...DAILY, "--dry-run")).toBe(2);
    expect(err.join("")).toContain("needs --type");
    expect(await run(...DAILY, "--type", "daily-overview", "--facts", fx.facts)).toBe(2);
  });
});
