import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GhExec } from "@titan-design/github";
import { parseTaskList } from "./active-work-tasks.js";
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
};

/** A fake `gh pr list` that answers from canned rows by search, and records each argv. */
export function fakeGh(rows: Record<string, unknown[]> = PRS): GhExec & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = async (args: readonly string[]) => {
    calls.push([...args]);
    const search = args[args.indexOf("--search") + 1] ?? "";
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
