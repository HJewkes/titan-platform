import path from "node:path";
import { PRICE_TABLE_VERSION } from "@titan-design/agent-protocol/pricing";
import { afterEach, describe, expect, it } from "vitest";
import { loadLanes } from "../../lanes-schema.js";
import { DAILY_FIXTURE, DAY, fakeCli, fakeGh, fixtureTasks, minerCostJson, REPO, SHEPHERD_STATS_JSON, snapshotStore } from "./daily-fakes.test-helpers.js";
import { dailyFactsMarkdown, dayWindow, gatherDaily, type GatherDailyOptions } from "./gather-daily.js";
import { priorityItems } from "./priorities.js";
import type { DigestItem } from "../../digest.js";
import type { SnapshotTask } from "./task-snapshot.js";

let store: ReturnType<typeof snapshotStore>;
afterEach(() => store.cleanup());

function options(overrides: Partial<GatherDailyOptions> = {}): GatherDailyOptions {
  return {
    day: DAY, repos: [REPO], transcriptRoots: [path.join(DAILY_FIXTURE, "transcripts")], initiative: "demo",
    snapshotDir: store.dir, gh: fakeGh(), listTasks: async () => fixtureTasks(), cli: fakeCli(), ...overrides,
  };
}

const byId = (items: readonly DigestItem[]) => new Map(items.map((item) => [item.id, item]));

describe("daily stats over injected CLI runners with synthetic output", () => {
  it("states the day's spend, its split by account, and cost per merged PR", async () => {
    store = snapshotStore();
    const cli = fakeCli({ "active-work miner": () => minerCostJson(40, { desk: 30, night: 10, idle: 0 }), "titan-factory shepherd": () => SHEPHERD_STATS_JSON });

    const { digest } = await gatherDaily(options({ cli }));
    const items = byId(digest.items);

    expect(items.get("stat/spend")).toMatchObject({ kind: "stat", title: "$40 spent across 4 sessions", summary: `priced at price table v${PRICE_TABLE_VERSION}`, priority: "P1" });
    expect(items.get("stat/spend/desk")?.title).toBe("$30 spent on account desk");
    expect(items.get("stat/spend/night")?.title).toBe("$10 spent on account night");
    expect(items.has("stat/spend/idle")).toBe(false);
    expect(items.get("stat/cost-per-pr")).toMatchObject({ title: "$20.00 spent per merged PR", summary: "$40 over 2 merged PRs" });
  });

  it("says when an older price table priced the spend, in the fact and in a note", async () => {
    store = snapshotStore();
    const cli = fakeCli({ "active-work miner": () => minerCostJson(40, { desk: 40 }, PRICE_TABLE_VERSION - 1), "titan-factory shepherd": () => SHEPHERD_STATS_JSON });

    const { digest, notes } = await gatherDaily(options({ cli }));

    expect(byId(digest.items).get("stat/spend")?.summary).toBe(`priced at price table v${PRICE_TABLE_VERSION - 1}, not the current v${PRICE_TABLE_VERSION}`);
    expect(notes).toContain(`stats: spend is priced at price table v${PRICE_TABLE_VERSION - 1}, not the current v${PRICE_TABLE_VERSION}`);
  });

  it("charts seven days of spend and merges, today's merges taken from the gather", async () => {
    store = snapshotStore();

    const { digest } = await gatherDaily(options());

    expect(byId(digest.items).get("stat/trend")?.summary).toBe(
      "dollars per day: 03-05: 20, 03-06: 20, 03-07: 20, 03-08: 20, 03-09: 20, 03-10: 20, 03-11: 40 · merges per day: 03-05: 0, 03-06: 0, 03-07: 0, 03-08: 0, 03-09: 0, 03-10: 3, 03-11: 2",
    );
  });

  it("names the day's owner touches, gate waits, week stage medians and newly owner-gated tasks", async () => {
    store = snapshotStore();

    const { digest } = await gatherDaily(options());
    const items = byId(digest.items);

    expect(items.get("slow/owner-touches")?.title).toBe("3 owner touches on Shepherd gates");
    expect(items.get("slow/gate-wait/approve-merge")).toMatchObject({ title: "approve-merge gates waited a median 1.5 hours on the owner", summary: "3 gates, the longest 4 hours" });
    expect(items.get("slow/stage/ci")).toMatchObject({ title: "ci stage this week (2026-W11)", summary: `${REPO} median 12 min, p90 30 min over 6 runs` });
    expect(items.get("slow/owner-gated")?.title).toBe("1 task became owner-gated");
  });

  it("reads stage medians over the ISO week up to the day, and owner touches over the day alone", async () => {
    store = snapshotStore();
    const dayOnly = JSON.stringify({ ...JSON.parse(SHEPHERD_STATS_JSON), stageTimes: [{ repo: REPO, week: "2026-W11", stages: [{ stage: "ci", runs: 1, medianMinutes: 99, p90Minutes: 99 }] }] });
    const weekOnly = JSON.stringify({ ...JSON.parse(SHEPHERD_STATS_JSON), ownerFriction: [{ day: DAY, ownerTouches: 9, kinds: [] }] });
    const cli = fakeCli({ "active-work miner": () => minerCostJson(20), "titan-factory shepherd": (argv) => (argv[4] === "2026-03-09" ? weekOnly : dayOnly) });

    const { digest } = await gatherDaily(options({ cli }));
    const items = byId(digest.items);

    expect(cli.calls.filter((argv) => argv[0] === "titan-factory").map((argv) => argv.slice(3, 7))).toEqual(
      expect.arrayContaining([["--from", DAY, "--to", DAY], ["--from", "2026-03-09", "--to", DAY]]));
    expect(items.get("slow/stage/ci")?.summary).toBe(`${REPO} median 12 min, p90 30 min over 6 runs`);
    expect(items.get("slow/owner-touches")?.title).toBe("3 owner touches on Shepherd gates");
  });

  it("turns a failing CLI into a note and missing facts, and the gather still completes", async () => {
    store = snapshotStore();
    const cli = fakeCli({ "active-work miner": () => minerCostJson(20) });

    const { digest, notes } = await gatherDaily(options({ cli }));
    const ids = digest.items.map((item) => item.id);

    expect(notes).toEqual(["stats: titan-factory shepherd stats exited 127: titan-factory: command not found"]);
    expect(ids.some((id) => id.startsWith("slow/"))).toBe(false);
    expect(ids).toContain("stat/spend");
    expect(ids).toContain(`pr/${REPO}#11/merged`);
  });

  it("leaves session rows out of facts.md, keeping them in the digest behind one rollup row", async () => {
    store = snapshotStore();

    const { digest } = await gatherDaily(options());
    const facts = dailyFactsMarkdown(digest);

    expect(digest.items.filter((item) => item.kind === "session")).toHaveLength(2);
    expect(facts).not.toContain("| session/");
    expect(facts).toContain("| sessions/rollup | 2 sessions active | |");
  });
});

describe("daily priorities", () => {
  const task = (id: string, priority: number | null, tags: string[], status = "open"): SnapshotTask => ({ id, title: `Synthetic task ${id}`, status, tags, priority });

  it("names each lane's two open tasks with the lowest priority rank", () => {
    const tasks = [task("DM-1", 9, ["daily"]), task("DM-2", 2, ["daily"]), task("DM-3", 1, ["daily"], "done"), task("DM-4", 5, ["daily"]), task("DM-5", 3, []), task("DM-6", null, [])];

    const items = priorityItems(tasks, loadLanes(), dayWindow(DAY));

    expect(items.map((item) => [item.id, item.lane])).toEqual([["next/DM-2", "video"], ["next/DM-4", "video"], ["next/DM-5", "factory"]]);
    expect(items[0]?.summary).toBe("DM-2 is priority 2 in the Video lane");
  });
});
