// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { fixtureActiveWork } from "../server/fixtures.js";
import { readWeeklySheet } from "../server/weekly-sheet.js";
import { readInitiative } from "../server/work.js";
import { renderPage } from "./render-page.test-helpers.js";

afterEach(cleanup);

/** The answers the console daemon gives over the synthetic active-work fixture; only orbit-relay has a sheet. */
async function recorded(): Promise<Snapshot> {
  const activeWork = fixtureActiveWork();
  const calls: Snapshot["calls"] = {};
  for (const slug of ["orbit-relay", "lantern-docs"]) {
    calls[snapshotKey("work.initiative", { slug })] = successEnvelope(await readInitiative(activeWork, slug));
    calls[snapshotKey("work.sheet", { slug })] = successEnvelope(await readWeeklySheet(activeWork, slug));
  }
  return { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls };
}

function renderConsole(hash: string, snapshot: Snapshot): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  renderPage(pageDataSource({ doc: page }), hash, { inApp: false });
}

describe("the weekly sheet on the initiative page", () => {
  it("shows every section of the sheet and names the bet lines that cite no intent line", async () => {
    renderConsole("#/initiatives/orbit-relay", await recorded());

    const body = await screen.findByTestId("weekly-sheet-body");

    for (const title of ["Statement", "Moved", "Not moved", "Proposed bets", "Proposed stops"]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }
    expect(body.textContent).toContain("orbit-relay/B3");
    expect(screen.getByText("Open until 2031-03-10")).toBeTruthy();
    expect(screen.getByText("1 bet line cites no intent line: orbit-relay/B4")).toBeTruthy();
  });

  it("says so when the initiative has no sheet yet", async () => {
    renderConsole("#/initiatives/lantern-docs", await recorded());

    expect(await screen.findByText("No weekly sheet yet")).toBeTruthy();
    expect(screen.queryByTestId("weekly-sheet-body")).toBeNull();
  });
});
