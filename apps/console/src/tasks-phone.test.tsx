// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../server/commands.js";
import { listPage } from "../server/task-list.js";
import { BELOW_MD } from "./pages/phone.js";
import { renderPage } from "./render-page.test-helpers.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Row = ConsoleCommands["work.tasks"]["result"]["tasks"][number];

// Synthetic rows in `work.tasks` shape; nothing here comes from a real workspace.
const ROWS: Row[] = [
  { slug: "orbit-relay", id: "OR-1", title: "Retry a dropped handshake", severity: "critical", stage: "review", stageReason: "PR example/orbit#41 is open", stageGuessed: false },
  { slug: "lantern-docs", id: "LD-3", title: "Merge the battery chapters", stage: "ready", stageReason: "No signal", stageGuessed: true },
];

const SNAPSHOT: Snapshot = {
  format: SNAPSHOT_FORMAT,
  createdAt: "2031-03-05T00:00:00.000Z",
  calls: {
    [snapshotKey("work.tasks", {})]: successEnvelope({ fetchedAt: "2031-03-05T00:00:00.000Z", evidence: { repos: ["example/orbit"], degraded: [] }, ...listPage(ROWS, {}) }),
  },
};

const onPhone = (): void =>
  void vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === BELOW_MD, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

describe("the tasks list on a phone", () => {
  it("stacks each task into a card with its id, title, initiative and stage instead of the table", async () => {
    onPhone();
    renderPage(SNAPSHOT, "#/tasks");

    const card = await screen.findByTestId("task-card-OR-1");
    expect(screen.queryAllByTestId(/^task-row-/)).toEqual([]);
    expect(screen.getAllByTestId(/^task-card-/)).toHaveLength(ROWS.length);
    for (const text of ["OR-1", "Retry a dropped handshake", "In review", "orbit-relay · critical"]) expect(within(card).getByText(text)).toBeTruthy();
    expect(within(screen.getByTestId("task-card-LD-3")).getByText("lantern-docs · no severity")).toBeTruthy();
  });

  it("gives each card's task link a 44px tap target", async () => {
    onPhone();
    renderPage(SNAPSHOT, "#/tasks");

    const link = within(await screen.findByTestId("task-card-LD-3")).getByText("LD-3");
    expect(link.className).toContain("min-h-11");
  });

  it("keeps the table on a desktop", async () => {
    renderPage(SNAPSHOT, "#/tasks");

    expect(await screen.findByTestId("task-row-OR-1")).toBeTruthy();
    expect(screen.queryAllByTestId(/^task-card-/)).toEqual([]);
  });
});
