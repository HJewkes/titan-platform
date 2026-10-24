import type { DigestItem } from "../../digest.js";
import { LanesFileSchema, type LanesFile } from "../../lanes-schema.js";
import type { SnapshotTask } from "./task-snapshot.js";

/** Synthetic only: an invented widgets shop with three lanes. */
export const WIDGETS = "acme/widgets";
export const WINDOW = { since: "2030-01-02T00:00:00.000Z", until: "2030-01-03T00:00:00.000Z" };

export function widgetLanes(overrides: Partial<LanesFile> = {}): LanesFile {
  return LanesFileSchema.parse({
    schema: "daily-lanes/v1",
    fallback: "shop",
    sideQuestTags: ["kind:upkeep", "flake"],
    rank: ["role", "closed", "estimate", "severity", "prs", "size"],
    named: { lanesBlockS: 60, laneFloorS: 10, secondsPerThread: 12, min: 1, max: 4 },
    ships: { count: 3, perLane: 2 },
    lanes: [
      { id: "studio", label: "Studio", seats: ["st"], paths: ["products/studio"], goals: [{ id: "launch", line: "Launch the studio", tags: ["studio"] }] },
      { id: "desk", label: "Desk", seats: ["dk"], paths: ["apps/desk"] },
      { id: "shop", label: "Shop", seats: ["sh"], goals: [{ id: "orders", line: "Orders ship same day", tags: ["orders"] }] },
    ],
    ...overrides,
  });
}

export function mergedPr(number: number, title: string, branch: string, packages: string[], size = 10): DigestItem {
  return {
    id: `pr/${WIDGETS}#${number}/merged`, kind: "pull-request", title, at: "2030-01-02T12:00:00.000Z", repo: WIDGETS,
    change: "merged", branch, outcome: `${title}.`, packages, size, priority: "P1",
  };
}

export function task(id: string, tags: string[], doneAt?: string, extra: Partial<SnapshotTask> = {}): SnapshotTask {
  return { id, title: `Task ${id}`, status: doneAt ? "done" : "open", tags, created: "2030-01-01", done_at: doneAt ?? null, ...extra };
}
