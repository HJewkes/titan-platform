// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { SCORECARD_ANSWERS } from "../server/twin/scorecard.js";
import { renderPage } from "./render-page.test-helpers.js";

afterEach(cleanup);

/** The twin's synthetic scorecard: W10 open with upkeep over its cap, W09 frozen and clean; OR-15's labels are inferred. */
function snapshot(overrides: Snapshot["calls"] = {}): Snapshot {
  const calls = Object.fromEntries(SCORECARD_ANSWERS.map(({ command, args, result }) => [snapshotKey(command, args), successEnvelope(result)]));
  return { format: SNAPSHOT_FORMAT, createdAt: "2031-03-06T00:00:00.000Z", calls: { ...calls, ...overrides } };
}

describe("the ticket scorecard page", () => {
  it("page shows red flag for upkeep over cap", async () => {
    renderPage(snapshot(), "#/scorecard");

    const headline = await screen.findByTestId("scorecard-headline");
    expect(within(headline).getByTestId("scorecard-red-flags").textContent).toContain("upkeep over cap");
    expect(screen.getByTestId("scorecard-week-2031-W10").textContent).toBe("W10 · 1 red");
    expect(within(screen.getByTestId("scorecard-row-dispatcher-orbit-coord")).getByText("upkeep over cap")).toBeTruthy();
    expect(within(screen.getByTestId("scorecard-row-dispatcher-kiln-coord")).queryByText("upkeep over cap")).toBeNull();
  });

  it("shows no red flag for a week under every cap", async () => {
    renderPage(snapshot(), "#/scorecard?week=2031-W09");

    const headline = await screen.findByTestId("scorecard-headline");
    expect(within(headline).getByText("Week 2031-W09")).toBeTruthy();
    expect(within(headline).queryByTestId("scorecard-red-flags")).toBeNull();
    expect(screen.getByTestId("scorecard-week-2031-W09").textContent).toBe("W09");
  });

  it("inferred badge shows on an inferred class", async () => {
    renderPage(snapshot(), "#/scorecard");

    const inferred = within(await screen.findByTestId("scorecard-week-tasks")).getByTestId("scorecard-task-OR-15");
    expect(within(inferred).getByTestId("scorecard-task-OR-15-class-inferred").textContent).toBe("inferred");
    const recorded = within(screen.getByTestId("scorecard-week-tasks")).getByTestId("scorecard-task-OR-12");
    expect(within(recorded).queryByText("inferred")).toBeNull();
    expect(within(screen.getByTestId("scorecard-stat-upkeep")).getByText("inferred")).toBeTruthy();
  });

  it("shows a figure that was not measured as not measured, never as zero", async () => {
    renderPage(snapshot(), "#/scorecard");

    const kiln = await screen.findByTestId("scorecard-row-dispatcher-kiln-coord");
    expect(within(kiln).getByText("not measured")).toBeTruthy();
    expect(within(kiln).queryByText("$0.00")).toBeNull();
    expect(within(screen.getByTestId("scorecard-seat")).getByText(/Not measured: seats/)).toBeTruthy();
  });

  it("says why when the host has no scorecard store", async () => {
    const missing = { store: { state: "missing", detail: "no scorecard store on this host yet" }, weeks: [] };
    renderPage(snapshot({ [snapshotKey("scorecard.weeks", {})]: successEnvelope(missing) }), "#/scorecard");

    expect(await screen.findByText("Scorecard missing")).toBeTruthy();
    expect(screen.getByText("no scorecard store on this host yet")).toBeTruthy();
  });

  it("offers no control that writes", async () => {
    renderPage(snapshot(), "#/scorecard");
    await screen.findByTestId("scorecard-headline");

    expect(screen.queryAllByRole("button").filter((button) => /confirm|correct|label|save/i.test(button.textContent))).toHaveLength(0);
  });
});

describe("a scorecard task's row", () => {
  it("marks each inferred column and leaves recorded ones bare", async () => {
    renderPage(snapshot(), `#/scorecard/${encodeURIComponent("orbit-relay/OR-15")}`);

    const detail = await screen.findByTestId("scorecard-task-detail");
    expect(within(detail).getByTestId("scorecard-field-classAtDispatch-inferred")).toBeTruthy();
    expect(within(detail).getByTestId("scorecard-field-sourceAtDispatch-inferred")).toBeTruthy();
    expect(within(detail).queryByTestId("scorecard-field-doneReason-inferred")).toBeNull();
  });

  it("refuses a route that names no task", async () => {
    renderPage(snapshot(), "#/scorecard/orbit-relay");

    expect(await screen.findByText(/orbit-relay names no scorecard task/)).toBeTruthy();
  });
});
