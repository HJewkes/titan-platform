import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { depositItemId } from "@titan-design/owner-queue";
import { withdrawnFileName, writeDeposit } from "@titan-design/owner-queue/spool";
import { bannerBlockers, blockersCommands, type BannerInput, type SpoolBlocker } from "./blockers.js";
import { resolveConfig } from "./config.js";
import type { ShepherdSource } from "./shepherd.js";

type WatchRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function row(runId: string, pr: number, overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    repo: "example-org/repo", pr, branch: `feat/${pr}`, runId, task: "EX-1", phase: "awaiting-approval", headSha: "a1b2c3d", phaseSince: ago(0),
    nextAction: "owner: resolve approve-merge", pendingGate: null, held: null, stalled: null,
    ...overrides,
  };
}

const gated = (runId: string, pr: number, sinceMs: number, stepId = "approve-merge"): WatchRow =>
  row(runId, pr, { pendingGate: { gateId: `${runId}/${stepId}`, stepId, since: ago(sinceMs) } });

const held = (runId: string, pr: number, sinceMs: number, satisfiedAt?: string): WatchRow =>
  row(runId, pr, { phase: "merging", phaseSince: ago(sinceMs), held: { reason: "ci-policy-weakened: a check was dropped", ...(satisfiedAt !== undefined && { satisfiedAt }) } });

function spoolBlocker(depositId: string, sinceMs: number, overrides: Partial<SpoolBlocker> = {}): SpoolBlocker {
  return { id: depositItemId("seat-a", depositId), asker: "seat-a", summary: `Blocked on ${depositId}`, blocker: { since: ago(sinceMs), blocks: "EX-2 cannot start" }, ...overrides };
}

const banner = (input: Partial<BannerInput>) => bannerBlockers({ spoolItems: [], rows: [], now: NOW, thresholdHours: 12, ...input });

describe("bannerBlockers threshold", () => {
  it("a 148 h wait banners at the 12 h default", () => {
    const result = banner({ rows: [gated("run-1", 7, 148 * HOUR)] });

    expect(result.count).toBe(1);
    expect(result.items[0]).toMatchObject({ id: "gate:run-1/approve-merge", source: "owner-gate", ageHours: 148, link: "#/inbox/gate%3Arun-1%2Fapprove-merge", blocks: "example-org/repo#7" });
  });

  it("the same gate shows on the first read past 12 h, not only at 148 h", () => {
    const result = banner({ rows: [gated("run-1", 7, 12 * HOUR + MINUTE)] });

    expect(result.items.map((item) => item.id)).toEqual(["gate:run-1/approve-merge"]);
  });

  it("a blocker at exactly N h is not bannered, just over is", () => {
    const at = banner({ spoolItems: [spoolBlocker("exact", 12 * HOUR)] });
    const over = banner({ spoolItems: [spoolBlocker("over", 12 * HOUR + MINUTE)] });
    const under = banner({ spoolItems: [spoolBlocker("under", 11 * HOUR + 59 * MINUTE)] });

    expect([at.count, over.count, under.count]).toEqual([0, 1, 0]);
  });

  it("a configured N of 24 moves the threshold", () => {
    const items = [spoolBlocker("twenty", 20 * HOUR), spoolBlocker("thirty", 30 * HOUR)];

    const result = bannerBlockers({ spoolItems: items, rows: [], now: NOW, thresholdHours: resolveConfig({ TITAN_CONSOLE_BLOCKER_HOURS: "24" }, "/srv/tester").blockerHours! });

    expect(result.thresholdHours).toBe(24);
    expect(result.items.map((item) => item.summary)).toEqual(["Blocked on thirty"]);
  });
});

describe("bannerBlockers sources", () => {
  it("a satisfied hold is not a blocker", () => {
    const result = banner({ rows: [held("run-1", 7, 48 * HOUR, ago(HOUR)), held("run-2", 8, 48 * HOUR)] });

    expect(result.items.map((item) => item.id)).toEqual(["held:run-2"]);
    expect(result.items[0]).toMatchObject({ source: "owner-hold", link: "#/shepherd/example-org%2Frepo%238" });
  });

  it("a seat-step gate never shows, even repeated", () => {
    const result = banner({ rows: [gated("run-1", 7, 48 * HOUR, "ci-failed"), gated("run-2", 8, 48 * HOUR, "sh-sent-back:2")] });

    expect(result.count).toBe(0);
  });

  it("a gate on an unpinned or diverged run never shows", () => {
    const unpinned = { ...gated("run-1", 7, 48 * HOUR), headSha: null };
    const diverged = { ...gated("run-2", 8, 48 * HOUR), stalled: { reason: "replay diverged at step 3" } };

    expect(banner({ rows: [unpinned, diverged] }).count).toBe(0);
  });

  it("a hold with a gate pending is listed once, as the gate", () => {
    const both = { ...gated("run-1", 7, 48 * HOUR), held: { reason: "owner-asked: wait" } };

    expect(banner({ rows: [both] }).items.map((item) => item.source)).toEqual(["owner-gate"]);
  });

  it("an expired blocker deposit never shows", () => {
    const result = banner({ spoolItems: [spoolBlocker("expired", 48 * HOUR, { expiresAt: ago(MINUTE) }), spoolBlocker("open", 48 * HOUR, { expiresAt: ago(-HOUR) })] });

    expect(result.items.map((item) => item.summary)).toEqual(["Blocked on open"]);
  });

  it("a blocker whose asker is gone still shows, tagged, and only when the roster was read", () => {
    const item = spoolBlocker("gone", 48 * HOUR);

    expect(banner({ spoolItems: [item], liveAgents: new Set(["seat-b"]) }).items[0]?.askerGone).toBe(true);
    expect(banner({ spoolItems: [item], liveAgents: new Set(["seat-a"]) }).items[0]?.askerGone).toBeUndefined();
    expect(banner({ spoolItems: [item] }).items[0]?.askerGone).toBeUndefined();
  });

  it("lists the oldest five first and counts them all", () => {
    const items = Array.from({ length: 7 }, (_, index) => spoolBlocker(`d${index}`, (20 + index) * HOUR));

    const result = banner({ spoolItems: items });

    expect(result.count).toBe(7);
    expect(result.items.map((item) => item.summary)).toEqual(["Blocked on d6", "Blocked on d5", "Blocked on d4", "Blocked on d3", "Blocked on d2"]);
  });
});

describe("blocker hours config", () => {
  it("defaults to 12 and refuses 0, 721 and a word", () => {
    expect(resolveConfig({}, "/srv/tester").blockerHours).toBe(12);
    for (const raw of ["0", "721", "abc", "1.5"]) expect(() => resolveConfig({ TITAN_CONSOLE_BLOCKER_HOURS: raw }, "/srv/tester")).toThrow(/TITAN_CONSOLE_BLOCKER_HOURS/);
  });
});

describe("blockers.banner", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "console-blockers-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const deposit = (depositId: string, blocker?: { since: string; blocks: string }) =>
    writeDeposit(dir, { depositId, asker: "seat-a", kind: "do", door: "two-way", summary: `Deposit ${depositId}`, context: "Synthetic.", keys: [], ...(blocker && { blocker }) });

  const shepherd = (list: ShepherdSource["list"]): ShepherdSource => ({ list }) as ShepherdSource;

  it("lists open blocker deposits from the spool and a gap when Shepherd cannot be read", async () => {
    await deposit("plain");
    await deposit("raised", { since: ago(30 * HOUR), blocks: "EX-2 cannot start" });
    await deposit("cleared", { since: ago(40 * HOUR), blocks: "EX-3 cannot start" });
    await writeFile(path.join(dir, withdrawnFileName(depositItemId("seat-a", "cleared"))), "{}\n");
    const commands = blockersCommands({ spoolDir: dir, shepherd: shepherd(() => Promise.reject(new Error("factory down"))), now: () => NOW });

    const result = await commands["blockers.banner"].run({}, {} as never);

    expect(result.items.map((item) => item.summary)).toEqual(["Deposit raised"]);
    expect(result.gaps).toEqual(["shepherd: factory down"]);
  });

  it("reads Shepherd's active rows once while the cached read is fresh", async () => {
    const states: string[] = [];
    const commands = blockersCommands({ spoolDir: dir, shepherd: shepherd(async (state) => (states.push(state), [gated("run-1", 7, 148 * HOUR)])), now: () => NOW });

    await commands["blockers.banner"].run({}, {} as never);
    const result = await commands["blockers.banner"].run({}, {} as never);

    expect(states).toEqual(["active"]);
    expect(result).toMatchObject({ count: 1, gaps: [] });
  });
});
