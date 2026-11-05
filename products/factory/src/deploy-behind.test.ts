import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitBehind } from "./deploy-behind.js";
import { deployHealth, withGitBehind } from "./deploy-health.js";

const RUNNING = "a".repeat(40);
const NOW = Date.parse("2026-10-07T12:00:00Z");
const minutesAgo = (minutes: number): number => NOW - minutes * 60_000;
const quiet = deployHealth({ entries: [], runningSha: RUNNING, now: NOW });

const record = (sha: string, time: number, paths: readonly string[]): string => `\u0001${sha} ${time / 1000}\n\n${paths.map((path) => `${path}\n`).join("")}`;
const gitLog = (times: number[], code = 0, stderr = "") => async () => ({ code, stdout: times.map((time, index) => record(`${index}`.repeat(40), time, ["docs/a.md"])).join(""), stderr });
const GRACE_MIN = 20;

describe("a running sha behind origin/main with no deploy asked", () => {
  it("reports the merges behind and the age of the oldest, and alarms past the threshold", async () => {
    const times = [5, 20, 30, 40, 50, 70, 80, 90, 100, 110].map(minutesAgo);

    const git = await gitBehind("/checkout", gitLog(times))(RUNNING);
    const result = withGitBehind(quiet, git, NOW);

    expect(result).toMatchObject({ behind: 9, behindMinutes: 110, alarm: true, originLag: { merges: 9, minutes: 110, asked: 0 } });
    expect(result.causes).toEqual([expect.stringContaining("origin/main holds 9 commits"), expect.stringContaining("for 110 min")]);
    expect(result.causes.join()).not.toContain("asked");
  });

  it("stays quiet when a few recent merges are behind", async () => {
    const git = await gitBehind("/checkout", gitLog([minutesAgo(5), minutesAgo(2)]))(RUNNING);

    expect(withGitBehind(quiet, git, NOW)).toMatchObject({ behind: 0, alarm: false });
  });

  it("ignores commits younger than the grace, so a fresh burst does not alarm", async () => {
    const git = await gitBehind("/checkout", gitLog([1, 5, 10, 15, GRACE_MIN - 1].map(minutesAgo)))(RUNNING);

    expect(withGitBehind(quiet, git, NOW)).toMatchObject({ behind: 0, behindMinutes: 0, alarm: false });
  });

  it("reads 0 only when origin/main holds nothing the build lacks", async () => {
    const git = await gitBehind("/checkout", gitLog([]))(RUNNING);

    expect(withGitBehind(quiet, git, NOW)).toMatchObject({ behind: 0, behindMinutes: 0, alarm: false });
  });

  it("keeps the larger of git's count and the log's", () => {
    const logged = { ...quiet, behind: 7, behindMinutes: 80 };

    expect(withGitBehind(logged, { commitTimes: [minutesAgo(30)] }, NOW)).toMatchObject({ behind: 7, behindMinutes: 80 });
  });
});

describe("fail closed when git cannot be read", () => {
  it("alarms on a git failure instead of reporting behind 0", async () => {
    const git = await gitBehind("/checkout", gitLog([], 128, "fatal: bad revision\nmore"))(RUNNING);
    const result = withGitBehind(quiet, git, NOW);

    expect(git).toEqual({ unknown: expect.stringContaining("exited 128: fatal: bad revision") });
    expect(result.alarm).toBe(true);
    expect(result.unverified).toContain("unknown");
  });

  it("alarms when git is not on PATH", async () => {
    expect(await gitBehind("/checkout", async () => undefined)(RUNNING)).toEqual({ unknown: "git is not on PATH" });
  });

  it("alarms when the running sha is unknown, without asking git", async () => {
    let asked = false;
    const git = await gitBehind("/checkout", async () => ((asked = true), undefined))("unknown");

    expect(asked).toBe(false);
    expect(withGitBehind(quiet, git, NOW).alarm).toBe(true);
  });

  it("compares a dirty build from its base commit", async () => {
    const seen: string[][] = [];
    await gitBehind("/checkout", async (_file, args) => (seen.push([...args]), { code: 0, stdout: "", stderr: "" }))(`${RUNNING}-dirty`);

    expect(seen[0]).toContain(`${RUNNING}..origin/main`);
  });
});

const FACTORY = ["products/factory"];
const DOCS_SHA = "d".repeat(40);
const FACTORY_SHA = "f".repeat(40);
const RELEASE_SHA = "e".repeat(40);
const manifest = (version: string): string => JSON.stringify({ name: "@titan-design/factory", version });

/** Answers git log with `records`, and git show with the factory manifest at 1.0.0 on a parent and 1.0.1 on its child. */
const fakeGit = (records: string) => async (_file: string, args: readonly string[]) => {
  const show = args.indexOf("show");
  if (show === -1) return { code: 0, stdout: records, stderr: "" };
  return { code: 0, stdout: manifest(String(args[show + 1]).includes("^:") ? "1.0.0" : "1.0.1"), stderr: "" };
};

describe("commits the deploy pacer would skip", () => {
  it("reads no lag when serve's only missing commit changes no path the factory build reads", async () => {
    const run = fakeGit(record(DOCS_SHA, minutesAgo(197), ["docs/guide.md", "packages/explainer/src/a.ts", "products/factory/README.md"]));

    const git = await gitBehind("/checkout", run, () => FACTORY)(RUNNING);

    expect(git).toEqual({ commitTimes: [] });
    expect(withGitBehind(quiet, git, NOW)).toMatchObject({ behind: 0, behindMinutes: 0, alarm: false });
  });

  it("starts the alarm clock at the oldest commit that reaches the build", async () => {
    const run = fakeGit(record(FACTORY_SHA, minutesAgo(90), ["products/factory/src/a.ts"]) + record(DOCS_SHA, minutesAgo(197), ["docs/guide.md"]));

    const result = withGitBehind(quiet, await gitBehind("/checkout", run, () => FACTORY)(RUNNING), NOW);

    expect(result).toMatchObject({ behind: 1, behindMinutes: 90, alarm: true });
    expect(result.causes).toEqual([expect.stringContaining("origin/main has held a commit serve does not run for 90 min")]);
  });

  it("skips a release that only bumps a factory manifest's version, as the deployer does", async () => {
    const run = fakeGit(record(RELEASE_SHA, minutesAgo(90), ["products/factory/package.json", "products/factory/CHANGELOG.md"]));

    expect(await gitBehind("/checkout", run, () => FACTORY)(RUNNING)).toEqual({ commitTimes: [] });
  });

  it("counts every commit when the build closure cannot be read", async () => {
    const run = fakeGit(record(DOCS_SHA, minutesAgo(90), ["docs/guide.md"]));

    expect(await gitBehind("/checkout", run, () => undefined)(RUNNING)).toEqual({ commitTimes: [minutesAgo(90)] });
  });
});

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

function commitFile(repo: string, path: string, text: string): string {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "-m", path);
  return git(repo, "rev-parse", "HEAD");
}

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A deploy checkout running `deployed` that has fetched an origin/main one commit past it. */
function checkoutBehindBy(path: string): { checkout: string; deployed: string } {
  const dir = mkdtempSync(join(tmpdir(), "factory-behind-paths-"));
  scratchDirs.push(dir);
  const origin = join(dir, "origin");
  git(dir, "init", "--quiet", "--initial-branch=main", origin);
  commitFile(origin, "pnpm-workspace.yaml", "packages:\n  - products/*\n");
  const deployed = commitFile(origin, "products/factory/package.json", manifest("1.0.0"));
  git(dir, "clone", "--quiet", origin, join(dir, "checkout"));
  commitFile(origin, path, "changed\n");
  git(join(dir, "checkout"), "fetch", "--quiet");
  return { checkout: join(dir, "checkout"), deployed };
}

describe("against a real checkout", () => {
  it("reads the closure from the checkout and skips a docs-only commit", async () => {
    const { checkout, deployed } = checkoutBehindBy("docs/guide.md");

    expect(await gitBehind(checkout)(deployed)).toEqual({ commitTimes: [] });
  });

  it("counts a commit that changes factory source", async () => {
    const { checkout, deployed } = checkoutBehindBy("products/factory/src/a.ts");

    expect(await gitBehind(checkout)(deployed)).toMatchObject({ commitTimes: [expect.any(Number)] });
  });
});
