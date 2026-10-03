// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { fixtureActiveWork, type FixtureOptions } from "../server/fixtures.js";
import { readInitiative, readPortfolio } from "../server/work.js";
import { App } from "./App.js";

afterEach(cleanup);

/** The answers the console daemon gives over the synthetic active-work fixture. */
async function recorded(options: FixtureOptions = {}): Promise<Snapshot> {
  const activeWork = fixtureActiveWork(options);
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: {
      [snapshotKey("work.portfolio", {})]: successEnvelope(await readPortfolio(activeWork)),
      [snapshotKey("work.initiative", { slug: "orbit-relay" })]: successEnvelope(await readInitiative(activeWork, "orbit-relay")),
      [snapshotKey("work.initiative", { slug: "garden-plan" })]: successEnvelope(await readInitiative(activeWork, "garden-plan")),
      [snapshotKey("work.initiative", { slug: "nowhere" })]: errorEnvelope('No initiative named "nowhere"', 66),
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

const row = (slug: string): HTMLElement => screen.getByTestId(`initiative-row-${slug}`);

describe("the initiatives view", () => {
  it("shows every initiative as a card under its state", async () => {
    renderConsole("#/initiatives", await recorded());
    expect(await screen.findByText("Orbit relay: message routing between stations")).toBeTruthy();
    expect(screen.getAllByTestId("initiative-card")).toHaveLength(5);
    expect(screen.getByText("Focused · by rank")).toBeTruthy();
  });

  it("lists each initiative's task, note, source and session counts", async () => {
    renderConsole("#/initiatives", await recorded());
    await screen.findByTestId("initiative-row-orbit-relay");
    expect(within(row("orbit-relay")).getAllByRole("cell").slice(1, 5).map((cell) => cell.textContent)).toEqual(["3", "2", "3", "2"]);
    expect(within(row("kiln-tools")).getAllByRole("cell").slice(1, 5).map((cell) => cell.textContent)).toEqual(["0", "0", "1", "0"]);
  });

  it("flags the personal initiative and no other", async () => {
    renderConsole("#/initiatives", await recorded());
    await screen.findByTestId("initiative-row-garden-plan");
    expect(within(row("garden-plan")).getByText("personal")).toBeTruthy();
    expect(screen.getAllByText("personal")).toHaveLength(1);
  });

  it("warns when active-work cannot say which initiatives are personal", async () => {
    renderConsole("#/initiatives", await recorded({ humanOnlyKnown: false }));
    expect(await screen.findByText(/could not say which initiatives are personal/)).toBeTruthy();
    expect(screen.getAllByText("personal")).toHaveLength(5);
  });

  it("opens an initiative's detail from its row", async () => {
    renderConsole("#/initiatives", await recorded());
    fireEvent.click(within(await screen.findByTestId("initiative-row-orbit-relay")).getByRole("link"));
    await waitFor(() => expect(window.location.hash).toBe("#/initiatives/orbit-relay"));
    expect(await screen.findByText("Why this exists")).toBeTruthy();
  });

  it("says so when the portfolio cannot be read", async () => {
    renderConsole("#/initiatives", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls: {} });
    expect(await screen.findByText(/Could not load initiatives/)).toBeTruthy();
  });
});

describe("an initiative's detail", () => {
  it("shows its brief, open loops and open tasks from a deep link", async () => {
    renderConsole("#/initiatives/orbit-relay", await recorded());
    expect(await screen.findByText("Why this exists")).toBeTruthy();
    expect(screen.getByText(/once the backoff numbers are in/)).toBeTruthy();
    expect(screen.getByText("Retry a dropped handshake with backoff")).toBeTruthy();
    expect(screen.getByText("Tasks (3)")).toBeTruthy();
  });

  it("says how many open tasks are shown when the list is capped", async () => {
    const capped = await recorded();
    capped.calls[snapshotKey("work.initiative", { slug: "orbit-relay" })] = successEnvelope(await readInitiative(fixtureActiveWork(), "orbit-relay", { taskLimit: 2 }));
    renderConsole("#/initiatives/orbit-relay", capped);
    expect(await screen.findByText("showing first 2 of 3 open")).toBeTruthy();
    expect(screen.getByText("Tasks (3)")).toBeTruthy();
    expect(screen.queryByText("Document the routing table format")).toBeNull();
  });

  it("lists its sessions, notes and sources under their tabs", async () => {
    renderConsole("#/initiatives/orbit-relay", await recorded());
    fireEvent.click(await screen.findByText("Sessions (2)"));
    expect(await screen.findByText("Handshake retry spike")).toBeTruthy();
    fireEvent.click(screen.getByText("Notes (2)"));
    expect(await screen.findByText("Cap the backoff at thirty seconds")).toBeTruthy();
    fireEvent.click(screen.getByText("Sources (2)"));
    expect(await screen.findByText("pr-41-handshake.md")).toBeTruthy();
    expect(screen.getByText("1 nested file under sources/ is counted here and not listed.")).toBeTruthy();
  });

  it("flags a personal initiative", async () => {
    renderConsole("#/initiatives/garden-plan", await recorded());
    expect(await screen.findByText("personal")).toBeTruthy();
  });

  it("returns to the portfolio from the breadcrumb", async () => {
    renderConsole("#/initiatives/orbit-relay", await recorded());
    fireEvent.click(await screen.findByRole("link", { name: "Initiatives" }));
    await waitFor(() => expect(window.location.hash).toBe("#/initiatives"));
  });

  it("says so for an initiative that does not exist", async () => {
    renderConsole("#/initiatives/nowhere", await recorded());
    expect(await screen.findByText(/Could not load nowhere: No initiative named "nowhere"/)).toBeTruthy();
  });
});
