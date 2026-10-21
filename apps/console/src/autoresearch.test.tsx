// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { errorEnvelope } from "@titan-design/registry";
import { snapshotKey, staticSource, type Snapshot } from "@titan-design/rpc-client";
import { twinSnapshot } from "../server/twin/snapshot.js";
import { App } from "./App.js";

let twin: Snapshot;

beforeAll(async () => {
  twin = await twinSnapshot();
});

afterEach(cleanup);

function renderConsole(hash: string, snapshot: Snapshot = twin): void {
  window.location.hash = hash;
  render(
    <RpcProvider source={staticSource({ snapshot })}>
      <App />
    </RpcProvider>,
  );
}

const rowValue = (header: HTMLElement, label: string): string => within(header).getByText(label).parentElement?.parentElement?.textContent ?? "";

const withAnswer = (command: string, args: unknown, envelope: Snapshot["calls"][string]): Snapshot => ({ ...twin, calls: { ...twin.calls, [snapshotKey(command, args)]: envelope } });

describe("the autoresearch page", () => {
  it("lists the run the twin's autoresearch.runs answers and opens its header", async () => {
    renderConsole("#/autoresearch");

    fireEvent.click(within(await screen.findByTestId("autoresearch-run-ar-7c1e")).getByText("ar-7c1e"));

    await waitFor(() => expect(window.location.hash).toBe("#/autoresearch/ar-7c1e"));
    expect(await screen.findByTestId("autoresearch-header")).toBeTruthy();
  });

  it("reads the run header from autoresearch.run, with the superseded winner apart from the stops", async () => {
    renderConsole("#/autoresearch/ar-7c1e");
    const header = await screen.findByTestId("autoresearch-header");

    expect(within(header).getByText("fixture-target · ar-7c1e")).toBeTruthy();
    expect(rowValue(header, "Round")).toContain("3 / 50");
    expect(rowValue(header, "Best score")).toContain("231.2 (+3.3 vs B₀ 234.5)");
    expect(rowValue(header, "Decisions")).toContain("kept 1 · rejected 1 · stopped 0 · superseded 1");
    expect(rowValue(header, "Lanes in use")).toContain("1 / 3");
  });

  it("shows the factory's error instead of an empty list when the runs read fails", async () => {
    renderConsole("#/autoresearch", withAnswer("autoresearch.runs", {}, errorEnvelope("factory not answering on port 7410: connect ECONNREFUSED", 69)));

    expect(await screen.findByText(/^Could not load the autoresearch runs: factory not answering/)).toBeTruthy();
    expect(screen.queryByText("The factory holds no autoresearch run")).toBeNull();
  });

  it("names a run the factory does not hold rather than show another", async () => {
    renderConsole("#/autoresearch/ar-0000", withAnswer("autoresearch.run", { runId: "ar-0000" }, errorEnvelope("factory autoresearch.run: no autoresearch run ar-0000", 64)));

    expect(await screen.findByText(/^Could not load autoresearch run ar-0000: .*no autoresearch run ar-0000/)).toBeTruthy();
    expect(screen.queryByTestId("autoresearch-header")).toBeNull();
  });

  it("still opens Home for an unknown view, its rail label included", () => {
    renderConsole("#/research");
    expect(within(screen.getByRole("tab", { name: "Home" })).getByTestId("nav-item-accent")).toBeTruthy();
    expect(screen.queryByTestId("autoresearch-header")).toBeNull();
  });
});

