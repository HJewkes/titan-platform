import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DigestSchema } from "../../digest.js";
import { DAILY_FIXTURE, DAY, fakeGh, fixtureTasks, REPO, snapshotStore } from "./daily-fakes.test-helpers.js";
import { dailyFactsMarkdown, dayWindow, gatherDaily, writeDailyGather, type GatherDailyOptions } from "./gather-daily.js";

let store: ReturnType<typeof snapshotStore>;
let outDirs: string[] = [];
afterEach(() => {
  store.cleanup();
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
  outDirs = [];
});

function options(overrides: Partial<GatherDailyOptions> = {}): GatherDailyOptions {
  return {
    day: DAY, repos: [REPO], transcriptRoots: [path.join(DAILY_FIXTURE, "transcripts")], initiative: "demo",
    snapshotDir: store.dir, gh: fakeGh(), listTasks: async () => fixtureTasks(), ...overrides,
  };
}

async function digestFile(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "explainer-daily-out-"));
  outDirs.push(dir);
  const files = await writeDailyGather(dir, (await gatherDaily(options())).digest);
  return readFileSync(files.digest, "utf8");
}

describe("gatherDaily over a fake gh, fixture transcripts and a frozen task snapshot", () => {
  it("collects PRs, sessions and task deltas under source-derived ids", async () => {
    store = snapshotStore();

    const { digest, notes } = await gatherDaily(options());

    expect(notes).toEqual([]);
    expect(digest.items.map((item) => item.id)).toEqual([
      `pr/${REPO}#11/merged`, `pr/${REPO}#11/opened`, `pr/${REPO}#12/opened`, `pr/${REPO}#9/merged`,
      "session/s-desk-001", "session/s-desk-002",
      "task/DM-2/closed", "task/DM-3/owner-gated", "task/DM-4/moved", "task/DM-5/opened",
    ]);
    expect(digest).toMatchObject({ since: "2026-03-11T00:00:00.000Z", until: "2026-03-12T00:00:00.000Z" });
  });

  it("writes a byte-identical digest.json on a second run", async () => {
    store = snapshotStore();

    const first = await digestFile();
    const second = await digestFile();

    expect(second).toBe(first);
    expect(DigestSchema.parse(JSON.parse(first)).items).toHaveLength(10);
  });

  it("leaves out a subagent sidechain and a session that ended before the day", async () => {
    store = snapshotStore();

    const { digest } = await gatherDaily(options());
    const sessions = digest.items.filter((item) => item.kind === "session");

    expect(sessions.map((item) => item.title)).toEqual(["Wire the parcel scanner", "Retry failed scans"]);
  });

  it("turns a repo gh cannot read into a note and keeps the rest of the day", async () => {
    store = snapshotStore();

    const { digest, notes } = await gatherDaily(options({ repos: ["example/missing", REPO] }));

    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("gh pr list --repo example/missing (opened) failed");
    expect(digest.items.filter((item) => item.kind === "pull-request")).toHaveLength(4);
  });

  it("notes the missing snapshot on a first day instead of guessing moves", async () => {
    store = snapshotStore();

    const { notes } = await gatherDaily(options({ day: "2026-03-08" }));

    expect(notes).toEqual(["no task snapshot before 2026-03-08; task moves are unknown, opened and closed come from task dates"]);
  });
});

describe("daily facts pack", () => {
  it("writes one row per item, keyed by the item id", () => {
    const digest = { ...dayWindow(DAY), items: [{ id: "task/DM-2/closed", kind: "task" as const, title: "Draft the label | printer spec", at: "2026-03-11T15:00:00.000Z", change: "closed" }] };

    expect(dailyFactsMarkdown(digest)).toContain("| task/DM-2/closed | task closed · Draft the label \\| printer spec |");
  });

  it("rejects a day the calendar does not have", () => {
    expect(() => dayWindow("2026-02-30")).toThrow(/not a calendar day/);
  });
});
