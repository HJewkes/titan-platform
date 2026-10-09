// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { fixtureActiveWork } from "../server/fixtures.js";
import { readNotes, readRecord, searchRecords } from "../server/work.js";
import { App } from "./App.js";

afterEach(cleanup);

const NOTE = "note:orbit-relay/2031-03-03-backoff-ceiling.md";
const SOURCE = "source:orbit-relay/pr-41-handshake.md";
const MISSING = "note:orbit-relay/missing.md";

/** The answers the console daemon gives over the synthetic active-work fixture. */
async function recorded(): Promise<Snapshot> {
  const activeWork = fixtureActiveWork();
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: {
      [snapshotKey("work.notes", {})]: successEnvelope(await readNotes(activeWork)),
      [snapshotKey("work.record", { ref: NOTE })]: successEnvelope(await readRecord(activeWork, NOTE)),
      [snapshotKey("work.record", { ref: SOURCE })]: successEnvelope({ ...(await readRecord(activeWork, SOURCE)), truncated: true }),
      [snapshotKey("work.record", { ref: MISSING })]: errorEnvelope("note sources/notes/missing.md not found", 66),
      [snapshotKey("work.search", { q: "station" })]: successEnvelope(await searchRecords(activeWork, "station")),
      [snapshotKey("work.search", { q: "nothing-matches" })]: successEnvelope(await searchRecords(activeWork, "nothing-matches")),
    },
  };
}

function renderConsole(hash: string, snapshot: Snapshot): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  window.location.hash = hash;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

const rows = (): string[] => screen.queryAllByTestId(/^knowledge-row-/).map((row) => row.getAttribute("data-testid")!.replace("knowledge-row-", ""));
const empty = (calls: Snapshot["calls"]): Snapshot => ({ format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls });

describe("the knowledge browser", () => {
  it("lists every note and source with its initiative and file", async () => {
    renderConsole("#/knowledge", await recorded());
    const row = await screen.findByTestId(`knowledge-row-${NOTE}`);
    expect(rows()).toHaveLength(7);
    expect(within(row).getByText("Cap the backoff at thirty seconds")).toBeTruthy();
    expect(within(row).getByText("orbit-relay")).toBeTruthy();
    expect(within(row).getByText("decision")).toBeTruthy();
  });

  it("filters by initiative, kind and date from the query string", async () => {
    renderConsole("#/knowledge?initiative=orbit-relay&kind=source&since=2031-02-21", await recorded());
    await screen.findByTestId(`knowledge-row-${SOURCE}`);
    expect(rows()).toEqual([SOURCE]);
  });

  it("puts a chosen kind into the query string", async () => {
    renderConsole("#/knowledge?initiative=kiln-tools", await recorded());
    await screen.findByTestId("knowledge-row-source:kiln-tools/deepdive-cone-chart.md");
    fireEvent.click(screen.getByText("Notes and sources"));
    fireEvent.click(await screen.findByText("Notes only"));
    await waitFor(() => expect(window.location.hash).toBe("#/knowledge?initiative=kiln-tools&kind=note"));
  });

  it("offers to clear filters that match nothing", async () => {
    renderConsole("#/knowledge?initiative=kiln-tools&kind=note", await recorded());
    expect(await screen.findByText("No notes or sources match these filters")).toBeTruthy();
    fireEvent.click(screen.getByText("Clear filters"));
    await waitFor(() => expect(window.location.hash).toBe("#/knowledge"));
  });

  it("opens a record from its row by its whole ref as one segment", async () => {
    renderConsole("#/knowledge", await recorded());
    fireEvent.click(within(await screen.findByTestId(`knowledge-row-${NOTE}`)).getByText("Cap the backoff at thirty seconds"));
    await waitFor(() => expect(window.location.hash).toBe(`#/knowledge/${encodeURIComponent(NOTE)}`));
  });

  it("says so when no initiative has a note or source", async () => {
    renderConsole("#/knowledge", empty({ [snapshotKey("work.notes", {})]: successEnvelope({ fetchedAt: "2031-03-05T00:00:00.000Z", records: [] }) }));
    expect(await screen.findByText("No notes or sources")).toBeTruthy();
    expect(screen.getByText("No initiative has a note or source file.")).toBeTruthy();
  });

  it("says so when the notes cannot be read", async () => {
    renderConsole("#/knowledge", empty({}));
    expect(await screen.findByText(/Could not load notes/)).toBeTruthy();
  });
});

describe("the knowledge search", () => {
  it("shows the hits for q from the query string, by ref", async () => {
    renderConsole("#/knowledge?tab=search&q=station", await recorded());
    expect(await screen.findByTestId("search-hit-note:orbit-relay/2031-02-27-station-clock-skew.md")).toBeTruthy();
    expect(screen.getByTestId("search-hit-source:orbit-relay/captures/station-7.md")).toBeTruthy();
  });

  it("puts a typed query into the query string", async () => {
    renderConsole("#/knowledge?tab=search", await recorded());
    fireEvent.change(await screen.findByLabelText("Search"), { target: { value: "station" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(window.location.hash).toBe("#/knowledge?tab=search&q=station"));
  });

  it("says so when nothing matches", async () => {
    renderConsole("#/knowledge?tab=search&q=nothing-matches", await recorded());
    expect(await screen.findByText('No results for "nothing-matches"')).toBeTruthy();
  });

  it("switches tabs through the query string", async () => {
    renderConsole("#/knowledge", await recorded());
    fireEvent.click(await screen.findByRole("tab", { name: "Search" }));
    await waitFor(() => expect(window.location.hash).toBe("#/knowledge?tab=search"));
  });
});

describe("a knowledge record", () => {
  it("renders the body as prose and links to its initiative", async () => {
    renderConsole(`#/knowledge/${encodeURIComponent(NOTE)}`, await recorded());
    expect(await screen.findByText("Cap the backoff at thirty seconds")).toBeTruthy();
    expect(within(screen.getByTestId("knowledge-body")).getByText("Decision")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "orbit-relay" }));
    await waitFor(() => expect(window.location.hash).toBe("#/initiatives/orbit-relay"));
  });

  it("says when the file was cut at active-work's read cap", async () => {
    renderConsole(`#/knowledge/${encodeURIComponent(SOURCE)}`, await recorded());
    expect(await screen.findByText("This file is longer than active-work's read cap; this is its head.")).toBeTruthy();
  });

  it("says there is no such record when active-work finds none", async () => {
    renderConsole(`#/knowledge/${encodeURIComponent(MISSING)}`, await recorded());
    expect(await screen.findByText(`No record ${MISSING}`)).toBeTruthy();
  });

  it("says so when the record cannot be read", async () => {
    renderConsole(`#/knowledge/${encodeURIComponent(NOTE)}`, empty({}));
    expect(await screen.findByText(new RegExp(`Could not load ${NOTE}`))).toBeTruthy();
  });
});
