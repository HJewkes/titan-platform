// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../server/commands.js";
import { listPage } from "../server/task-list.js";
import { BELOW_MD } from "./pages/phone.js";
import { renderPage, unmountPages } from "./render-page.test-helpers.js";

/* jsdom lays nothing out, so these check the classes and the tree that set the layout. */

afterEach(async () => {
  await unmountPages();
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

describe("the tasks layout", () => {
  it("shows every stage in one table under a single header, with a group row per stage and no stage badge", async () => {
    renderPage(SNAPSHOT, "#/tasks");

    await screen.findByTestId("stage-group-review");
    expect(screen.getAllByText("Task")).toHaveLength(1);
    expect(screen.queryByText("Stage")).toBeNull();
    expect(within(screen.getByTestId("stage-row-review")).getByText("In review (1)")).toBeTruthy();
    expect(within(screen.getByTestId("task-row-OR-1")).queryByText("In review")).toBeNull();
  });

  it("lays the filters out in one row on a desktop, the text filter taking the rest", async () => {
    renderPage(SNAPSHOT, "#/tasks");

    const bar = await screen.findByTestId("task-filters");
    expect(bar.classList.contains("flex-wrap")).toBe(false);
    expect(screen.getByLabelText("Filter by id or title").closest(".flex-1")).toBeTruthy();
  });

  it("stacks the filters full width on a phone", async () => {
    onPhone();
    renderPage(SNAPSHOT, "#/tasks");

    expect((await screen.findByTestId("task-filters")).classList.contains("flex-wrap")).toBe(true);
  });
});
