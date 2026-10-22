import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storybooksGcArgs, storybooksGcCli } from "./cli-storybooks.js";
import { resolveConfig } from "./config.js";
import { buildIdOf, type BuildFile } from "./storybook-build.js";
import { RETENTION, sweepStorybooks, type GcReport, type Retention } from "./storybook-gc.js";
import { removeStoredBuild } from "./storybook-store.js";

// Synthetic: rounds and stored builds written straight to a temp state dir; the sweep reads only sidecars and mtimes.
const NOW = new Date("2026-10-22T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const RULES: Retention = { ...RETENTION, capBytes: 30 };

let root: string;
let roundsDir: string;
let storybooksDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-storybook-gc-"));
  roundsDir = path.join(root, "state", "rounds");
  storybooksDir = path.join(root, "state", "storybooks");
  await mkdir(roundsDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);
const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex");

interface Stored {
  id: string;
  files: BuildFile[];
  sha: string;
}

/** A stored build of `bytes` bytes, its dir dated `ageDays` before NOW. */
async function stored(name: string, ageDays: number, bytes = 10): Promise<Stored> {
  const files = [{ path: "iframe.html", sha256: sha256Of(name), bytes }];
  const id = buildIdOf(files);
  const dir = path.join(storybooksDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "iframe.html"), "x".repeat(bytes));
  await utimes(dir, daysAgo(ageDays), daysAgo(ageDays));
  return { id, files, sha: sha256Of(name).slice(0, 40) };
}

const sidecar = ({ sha, files }: Stored) => ({ schema: "titan-review/storybook@1", repo: "example-org/example-ui", sha, dirty: false, builtAt: "2026-10-01T00:00:00Z", storybookVersion: "10.0.0", storyIds: 1, files });

/** A round naming `builds` (a storybook-set@1 sidecar for more than one); sent `sentDaysAgo` before NOW, or open. */
async function round(id: string, builds: Stored[], sentDaysAgo?: number): Promise<void> {
  const dir = path.join(roundsDir, id);
  await mkdir(path.join(dir, "storybook"), { recursive: true });
  const [only] = builds;
  const json = builds.length === 1 && only ? sidecar(only) : { schema: "titan-review/storybook-set@1", builds: builds.map(sidecar) };
  await writeFile(path.join(dir, "storybook", "storybook.json"), JSON.stringify(json));
  if (sentDaysAgo === undefined) return;
  await writeFile(path.join(dir, "feedback.json"), "{}");
  await utimes(path.join(dir, "feedback.json"), daysAgo(sentDaysAgo), daysAgo(sentDaysAgo));
}

const sweep = (dryRun = false, retention = RULES) => sweepStorybooks({ storybooksDir, roundsDir, dryRun, now: NOW, retention });
const inStore = async (): Promise<string[]> => (await readdir(storybooksDir)).sort();
const actions = (report: GcReport): Record<string, string> => Object.fromEntries(report.builds.map((entry) => [entry.buildId, entry.action]));

/** Open, recently sent and stale-sent references, and two unnamed builds where the cap leaves room for one. */
async function mixedStore() {
  const open = await stored("open", 30);
  const stale = await stored("stale", 30);
  const recent = await stored("recent", 30);
  const older = await stored("older-unnamed", 20);
  const newer = await stored("newer-unnamed", 10);
  await round("open-r1", [open]);
  await round("stale-r1", [stale], 15);
  await round("recent-r1", [recent], 3);
  return { open, stale, recent, older, newer };
}

describe("storybooks gc", () => {
  it("keeps open and recent rounds' builds, removes a stale round's, and over the cap removes the oldest unnamed build first", async () => {
    const { open, stale, recent, older, newer } = await mixedStore();

    const report = await sweep();

    expect(actions(report)).toEqual({ [open.id]: "kept", [stale.id]: "removed", [recent.id]: "kept", [older.id]: "removed", [newer.id]: "kept" });
    expect(await inStore()).toEqual([open.id, recent.id, newer.id].sort());
    expect(report.builds.find((entry) => entry.buildId === stale.id)?.reason).toBe("named only by rounds closed over 14 days ago: stale-r1");
    expect(report).toMatchObject({ bytesBefore: 50, bytesAfter: 30, blocked: null });
  });

  it("deletes nothing with --dry-run, while reporting what it would remove", async () => {
    const { stale, older } = await mixedStore();
    const before = await inStore();

    const report = await sweep(true);

    expect(await inStore()).toEqual(before);
    expect(report.builds.filter((entry) => entry.action === "removed").map((entry) => entry.buildId).sort()).toEqual([stale.id, older.id].sort());
  });

  it("keeps every build an open multi-PR round names, even over the cap", async () => {
    const first = await stored("group-7", 40);
    const second = await stored("group-8", 40);
    const unnamed = await stored("unnamed", 40);
    await round("multi-r1", [first, second]);

    const report = await sweep(false, { ...RULES, capBytes: 0 });

    expect(actions(report)).toEqual({ [first.id]: "kept", [second.id]: "kept", [unnamed.id]: "removed" });
  });

  it("never follows a symlink in the store, at a build's name or inside a build", async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "not the store's");
    const planted = buildIdOf([{ path: "iframe.html", sha256: sha256Of("planted"), bytes: 1 }]);
    await mkdir(storybooksDir, { recursive: true });
    await symlink(outside, path.join(storybooksDir, planted));
    const stale = await stored("stale", 30);
    await symlink(outside, path.join(storybooksDir, stale.id, "assets"));
    await utimes(path.join(storybooksDir, stale.id), daysAgo(30), daysAgo(30));
    await round("stale-r1", [stale], 15);
    await round("planted-r1", [{ id: planted, sha: "d".repeat(40), files: [{ path: "iframe.html", sha256: sha256Of("planted"), bytes: 1 }] }], 15);

    const report = await sweep(false, { ...RULES, capBytes: 0 });

    expect(report.skipped).toEqual([planted]);
    expect(actions(report)).toEqual({ [stale.id]: "removed" });
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("not the store's");
    await expect(removeStoredBuild(storybooksDir, planted)).rejects.toMatchObject({ message: expect.stringMatching(/as a symlink/) });
    expect(await readdir(outside)).toEqual(["keep.txt"]);
  });

  it("removes nothing when a round's storybook.json cannot be read, since it could name any build", async () => {
    const { stale } = await mixedStore();
    await mkdir(path.join(roundsDir, "broken-r1", "storybook"), { recursive: true });
    await writeFile(path.join(roundsDir, "broken-r1", "storybook", "storybook.json"), "not json");

    const report = await sweep();

    expect(report.blocked).toMatch(/^round broken-r1: the round's storybook\.json is not a storybook@1/);
    expect(report.builds.every((entry) => entry.action === "kept")).toBe(true);
    expect(await inStore()).toContain(stale.id);
  });

  it("never lets the cap take an unnamed build stored within the import grace", async () => {
    const landing = await stored("landing", 0);
    await utimes(path.join(storybooksDir, landing.id), NOW, NOW);

    const report = await sweep(false, { ...RULES, capBytes: 0 });

    expect(report.builds[0]).toMatchObject({ action: "kept", reason: expect.stringMatching(/import grace/) });
  });
});

describe("the storybooks gc verb", () => {
  it("parses --dry-run and --json in any order and refuses anything else", () => {
    expect(storybooksGcArgs(["storybooks", "gc"])).toEqual({ dryRun: false, json: false });
    expect(storybooksGcArgs(["storybooks", "gc", "--json", "--dry-run"])).toEqual({ dryRun: true, json: true });
    expect(storybooksGcArgs(["storybooks", "gc", "--dry-run", "--dry-run"])).toBeNull();
    expect(storybooksGcArgs(["storybooks", "gc", "--force"])).toBeNull();
  });

  it("prints each build it would remove and why, and deletes nothing on a dry run", async () => {
    const { stale } = await mixedStore();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = resolveConfig({ TITAN_CONSOLE_STATE: path.join(root, "state") }, root);

    await storybooksGcCli(config, { dryRun: true, json: false }, NOW);

    const printed = log.mock.calls.map(([text]) => String(text)).join("\n");
    expect(printed).toContain(`would remove ${stale.id} (0.0 MB): named only by rounds closed over 14 days ago: stale-r1`);
    expect(printed).toMatch(/dry run, nothing deleted$/);
    expect(await inStore()).toContain(stale.id);
  });
});
