// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { SNAPSHOT_FORMAT, type Snapshot } from "@titan-design/rpc-client";
import { App } from "./App.js";

afterEach(cleanup);

const EMPTY: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T12:00:30.000Z", calls: {} };

function renderConsole(hash: string): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", EMPTY), "text/html");
  window.location.hash = hash;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

const rowValue = (header: HTMLElement, label: string): string => within(header).getByText(label).parentElement?.parentElement?.textContent ?? "";

describe("the autoresearch page", () => {
  it("lists the synthetic run and opens its header", async () => {
    renderConsole("#/autoresearch");
    expect(screen.getByText(/^Preview: a synthetic run\./)).toBeTruthy();

    fireEvent.click(within(screen.getByTestId("autoresearch-run-ar-7c1e")).getByText("ar-7c1e"));

    await waitFor(() => expect(window.location.hash).toBe("#/autoresearch/ar-7c1e"));
    expect(await screen.findByTestId("autoresearch-header")).toBeTruthy();
  });

  it("reads the run header from the fixture, with the superseded winner apart from the stops", () => {
    renderConsole("#/autoresearch/ar-7c1e");
    const header = screen.getByTestId("autoresearch-header");

    expect(within(header).getByText("fixture-target · ar-7c1e")).toBeTruthy();
    expect(rowValue(header, "Round")).toContain("3 / 50");
    expect(rowValue(header, "Best score")).toContain("231.2 (+3.3 vs B₀ 234.5)");
    expect(rowValue(header, "Decisions")).toContain("kept 1 · rejected 1 · stopped 0 · superseded 1");
    expect(rowValue(header, "Lanes in use")).toContain("1 / 3");
  });

  it("names a run it does not hold rather than show another", () => {
    renderConsole("#/autoresearch/ar-0000");
    expect(screen.getByText("No autoresearch run ar-0000")).toBeTruthy();
    expect(screen.queryByTestId("autoresearch-header")).toBeNull();
  });

  it("still opens Home for an unknown view, its rail label included", () => {
    renderConsole("#/research");
    expect(within(screen.getByRole("tab", { name: "Home" })).getByTestId("nav-item-accent")).toBeTruthy();
    expect(screen.queryByTestId("autoresearch-header")).toBeNull();
  });
});
