// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { snapshotKey } from "@titan-design/rpc-client";
import { EXIT } from "@titan-design/rpc-protocol";
import { fixtureDataset, fixtureSnapshot } from "./test/fixture.js";
import { renderReport } from "./test/render.js";

afterEach(cleanup);

const nodeRoute = (id: string): string => `#/node/${encodeURIComponent(id)}`;
const findingRoute = (id: string): string => `#/finding/${encodeURIComponent(id)}`;

describe("Overview", () => {
  it("shows headline counts and the directories with rolled-up lines", async () => {
    renderReport("#/", fixtureSnapshot());
    expect(await screen.findByLabelText("Findings: 3")).toBeTruthy();
    expect(screen.getByLabelText("error: 1")).toBeTruthy();
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("link", { name: "src/" })).toBeTruthy();
    expect(within(table).getByText("440")).toBeTruthy();
    expect(within(table).getAllByText("higher is worse").length).toBeGreaterThan(0);
  });
});

describe("Priorities", () => {
  it("lists findings most severe first, with facet counts and paging", async () => {
    renderReport("#/priorities", fixtureSnapshot());
    const rows = await screen.findAllByRole("row");
    expect(within(rows[1]!).getByText("loc=400 > 300")).toBeTruthy();
    expect(screen.getByText("warning 2")).toBeTruthy();
    expect(screen.getByText("1 to 3 of 3")).toBeTruthy();
  });

  it("applies a filter from the route and keeps the other facet choices visible", async () => {
    renderReport("#/priorities?severity=warning", fixtureSnapshot());
    expect(await screen.findByText("1 to 2 of 2")).toBeTruthy();
    expect(screen.queryByText("loc=400 > 300")).toBeNull();
    expect(screen.getByText("error 1")).toBeTruthy();
  });

  it("says so when no finding matches", async () => {
    renderReport("#/priorities?rule=no-such-rule", fixtureSnapshot());
    expect(await screen.findByText("No findings match these filters.")).toBeTruthy();
  });
});

describe("Node", () => {
  it("shows a file's metrics with direction, its findings, and its neighbours", async () => {
    renderReport(nodeRoute("src/io.ts"), fixtureSnapshot());
    expect(await screen.findByRole("heading", { name: "src/io.ts" })).toBeTruthy();
    expect(await screen.findByText("src/io.ts imports node:fs")).toBeTruthy();
    expect(screen.getAllByText(/larger is worse/).length).toBeGreaterThan(0);
    expect(await screen.findByText("Uses (2)")).toBeTruthy();
  });

  it("shows a directory's children and explains why it has no neighbours", async () => {
    renderReport(nodeRoute("src/"), fixtureSnapshot());
    expect(await screen.findByRole("link", { name: "big.ts" })).toBeTruthy();
    expect(screen.getByText(/package matrix \(TD-35\)/)).toBeTruthy();
  });

  it("reports a node the snapshot does not hold as not found", async () => {
    renderReport(nodeRoute("src/missing.ts"), fixtureSnapshot());
    expect(await screen.findByText(/Not found/)).toBeTruthy();
  });
});

describe("Finding", () => {
  it("shows the excerpt with the flagged line highlighted", async () => {
    renderReport(findingRoute("no-fs|src/io.ts|node:fs"), fixtureSnapshot());
    const line = await screen.findByText('import { readFile } from "node:fs";');
    expect(line.closest("[data-highlighted]")).toBeTruthy();
    expect(screen.getByText(/must not import node:fs/)).toBeTruthy();
  });

  it("says the export did not carry the lines when a file's text is absent", async () => {
    renderReport(findingRoute("max-loc|src/big.ts"), fixtureSnapshot());
    expect(await screen.findByText("This static export did not carry these lines.")).toBeTruthy();
    expect(screen.getByText("400")).toBeTruthy();
  });
});

describe("Compare", () => {
  it("explains what identity across renames will enable", async () => {
    renderReport("#/compare", fixtureSnapshot());
    expect(await screen.findByText(/TP-187 carries identity across renames/)).toBeTruthy();
  });
});

describe("states every screen shares", () => {
  it("shows a loading state before the first answer", () => {
    renderReport("#/", fixtureSnapshot());
    expect(screen.getByLabelText(/Loading/)).toBeTruthy();
  });

  it("tells the reader to index when there are no snapshots", async () => {
    renderReport("#/", fixtureSnapshot(fixtureDataset({ snapshots: [] })));
    expect(await screen.findByText(/pnpm --filter code-report index/)).toBeTruthy();
  });

  it("marks a call the export cannot answer as unavailable, not as an error", async () => {
    const snapshot = fixtureSnapshot(null);
    renderReport("#/", snapshot);
    expect(await screen.findByText(/is not available from this source/)).toBeTruthy();
  });

  it("uses a recorded answer before the dataset", async () => {
    const snapshot = fixtureSnapshot();
    snapshot.calls[snapshotKey("api.describe", {})] = { ok: false, error: "recorded failure", code: EXIT.SOFTWARE };
    renderReport("#/", snapshot);
    expect(await screen.findByText(/recorded failure/)).toBeTruthy();
  });
});
