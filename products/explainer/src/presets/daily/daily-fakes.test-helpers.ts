import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRICE_TABLE_VERSION } from "@titan-design/agent-protocol/pricing";
import type { GhExec } from "@titan-design/github";
import { parseTaskList } from "./active-work-tasks.js";
import type { CliRun } from "./stats-source.js";
import type { SnapshotTask } from "./task-snapshot.js";

/** Synthetic only: an invented parcel-desk project, its repo, sessions and tasks. */
export const DAILY_FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/daily");
export const DAY = "2026-03-11";
export const REPO = "example/parcel-desk";

const PRS: Record<string, unknown[]> = {
  "created:2026-03-11": [
    { number: 12, title: "Add the desk dashboard", url: "https://github.com/example/parcel-desk/pull/12", createdAt: "2026-03-11T10:00:00Z", mergedAt: null },
    { number: 11, title: "Post scans to the desk server", url: "https://github.com/example/parcel-desk/pull/11", createdAt: "2026-03-11T09:40:00Z", mergedAt: "2026-03-11T16:00:00Z" },
  ],
  "merged:2026-03-11": [
    { number: 11, title: "Post scans to the desk server", url: "https://github.com/example/parcel-desk/pull/11", createdAt: "2026-03-11T09:40:00Z", mergedAt: "2026-03-11T16:00:00Z" },
    { number: 9, title: "Pin the scanner driver", url: "https://github.com/example/parcel-desk/pull/9", createdAt: "2026-03-09T12:00:00Z", mergedAt: "2026-03-11T08:00:00Z" },
  ],
  "merged-at:2026-03-10": [{ number: 5 }, { number: 7 }, { number: 8 }],
};

/** A fake `gh pr list` and `gh search prs` that answer from canned rows by search, and record each argv. */
export function fakeGh(rows: Record<string, unknown[]> = PRS): GhExec & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = async (args: readonly string[]) => {
    calls.push([...args]);
    const search = args[0] === "search" ? `merged-at:${args[args.indexOf("--merged-at") + 1]}` : (args[args.indexOf("--search") + 1] ?? "");
    const repo = args[args.indexOf("--repo") + 1];
    if (repo !== REPO) return { code: 1, stdout: "", stderr: `GraphQL: Could not resolve to a Repository with the name '${repo}'.` };
    return { code: 0, stdout: JSON.stringify(rows[search] ?? []), stderr: "" };
  };
  return Object.assign(gh, { calls });
}

export function fixtureTasks(): SnapshotTask[] {
  return parseTaskList(readFileSync(path.join(DAILY_FIXTURE, `tasks-${DAY}.json`), "utf8"));
}

/** A scratch snapshot store seeded with the frozen snapshots, since a gather writes the day's own. */
export function snapshotStore(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "explainer-daily-"));
  const dir = path.join(root, "task-snapshots");
  cpSync(path.join(DAILY_FIXTURE, "snapshots"), dir, { recursive: true });
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Synthetic `active-work miner cost --json`: one invented desk account spends the day's dollars. */
export function minerCostJson(usd: number, accounts: Record<string, number> = { desk: usd }, priceTableVersion: number = PRICE_TABLE_VERSION): string {
  const byAccount = Object.entries(accounts).map(([key, costUsd]) => ({ key, requests: 10, costUsd, sessions: 2 }));
  return JSON.stringify({ ok: true, data: { window: {}, priceTableVersion, totals: { requests: 10, costUsd: usd, sessions: 4, unpricedRequests: 0 }, byAccount } });
}

/** Synthetic `titan-factory shepherd stats --json` for the parcel-desk day. */
export const SHEPHERD_STATS_JSON = JSON.stringify({
  merges: [],
  ownerFriction: [{ day: DAY, ownerTouches: 3, kinds: [{ kind: "approve-merge", gates: 3, medianHours: 1.5, maxHours: 4 }] }],
  stageTimes: [{ repo: REPO, week: "2026-W11", stages: [{ stage: "ci", runs: 6, medianMinutes: 12, p90Minutes: 30, maxMinutes: 41 }] }],
});

/** A fake local CLI runner: canned stdout per command, keyed by its first two words; anything else exits 127. */
export function fakeCli(answers: Record<string, (argv: readonly string[]) => string> = {
  "active-work miner": (argv) => minerCostJson(argv[4] === `${DAY}T00:00:00.000Z` ? 40 : 20),
  "titan-factory shepherd": () => SHEPHERD_STATS_JSON,
}): CliRun & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => {
    calls.push([...argv]);
    const answer = answers[argv.slice(0, 2).join(" ")];
    return answer ? { code: 0, stdout: answer(argv), stderr: "" } : { code: 127, stdout: "", stderr: `${argv[0]}: command not found` };
  };
  return Object.assign(run, { calls });
}
