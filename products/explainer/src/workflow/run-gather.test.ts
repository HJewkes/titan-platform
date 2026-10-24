import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DAILY_FIXTURE, DAY, fakeGh, fixtureTasks, REPO } from "../presets/daily/daily-fakes.test-helpers.js";
import { fakeAuditionModel } from "../audition-fakes.test-helpers.js";
import { runRunCli } from "./run-cli.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

function cli(model: Parameters<typeof fakeHost>[1] = fakeScriptModel()) {
  const out: string[] = [];
  const err: string[] = [];
  const gather = { gh: fakeGh(), listTasks: async () => fixtureTasks() };
  const host = fakeHost(fx, model, fakeBridge());
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
    expect(out.join("")).toContain(`gathered 9 facts for daily-overview ${DAY}: ${facts}`);
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

describe("explainer run --from gather", () => {
  it("runs gatherDaily as the gather stage, and the audition reads the facts it gathered", async () => {
    fx = fixture();
    cpSync(path.join(DAILY_FIXTURE, "snapshots"), path.join(fx.dataDir, "task-snapshots"), { recursive: true });
    const { run, out, err } = cli(fakeAuditionModel());

    const code = await run(...DAILY, "--type", "daily-overview", "--from", "gather", "--to", "audition");
    const report = JSON.parse(readFileSync(path.join(path.dirname(out.join("").match(/report: (\S+)/)![1]!), "run-report.json"), "utf8"));
    const ran = report.rows.filter((r: { status: string }) => r.status === "ran").map((r: { stage: string }) => r.stage);
    const gather = report.rows.find((r: { stage: string }) => r.stage === "gather");

    expect(code, err.join("")).toBe(0);
    expect(ran).toEqual(["gather", "audition"]);
    expect(readFileSync(path.join(fx.dataDir, "artifacts", gather.outputs.facts), "utf8")).toBe(readFileSync(path.join(fx.dataDir, "gather", "daily-overview", DAY, "facts.md"), "utf8"));
    expect(gather.outputs.code).toBeUndefined();
  });

  it("refuses a run from gather with no --facts-from", async () => {
    fx = fixture();
    const { run, err } = cli();

    expect(await run("--from", "gather", "--to", "gather")).toBe(2);
    expect(err.join("")).toContain("a run from gather needs --facts-from");
  });
});

const ARTICLE_FIXTURE = fileURLToPath(new URL("../../fixtures/article/demo", import.meta.url));
const ARTICLE = ["--facts-from", "gatherArticle", "--type", "paper-summary", "--day", DAY, "--article", path.join(ARTICLE_FIXTURE, "article.md")];

describe("explainer run --facts-from gatherArticle", () => {
  it("gathers the article's checked claims and figures into the type's gather directory", async () => {
    fx = fixture();
    const { run, out, err } = cli();

    const code = await run(...ARTICLE, "--claims", path.join(ARTICLE_FIXTURE, "claims.json"), "--dry-run");
    const facts = path.join(fx.dataDir, "gather", "paper-summary", DAY, "facts.jsonl");

    expect(code, err.join("")).toBe(0);
    expect(out.join("")).toMatch(new RegExp(`gathered \\d+ facts for paper-summary ${DAY}: ${facts}`));
    expect(readFileSync(facts, "utf8")).toContain('"source":');
    expect(existsSync(path.join(fx.dataDir, "gather", "paper-summary", DAY, "rejected.json"))).toBe(true);
  });

  it("refuses gatherArticle without --claims", async () => {
    fx = fixture();
    const { run, err } = cli();

    expect(await run(...ARTICLE, "--dry-run")).toBe(2);
    expect(err.join("")).toContain("needs --article <path> and --claims <path>");
  });
});
