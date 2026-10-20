// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { App } from "./App.js";

afterEach(cleanup);

const SHA = "3f9a1c0b7e2d4a6f8b1c3e5d7f9a0b2c4d6e8f10";

function renderWithBuild(build: unknown): void {
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T12:00:00.000Z", calls: { [snapshotKey("console.build", {})]: { ok: true, data: { build } } } };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  window.location.hash = "#/sessions";
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

describe("the build footer", () => {
  it("shows the short sha and the build time of the served build", async () => {
    renderWithBuild({ sha: SHA, builtAt: "2031-03-05T09:41:12.000Z", dirty: false });
    expect((await screen.findByTestId("build-footer")).textContent).toBe("Build 3f9a1c0, built 2031-03-05 09:41 UTC");
  });

  it("marks a build made from a checkout with tracked changes", async () => {
    renderWithBuild({ sha: SHA, builtAt: "2031-03-05T09:41:12.000Z", dirty: true });
    expect((await screen.findByTestId("build-footer")).textContent).toContain("3f9a1c0 (dirty)");
  });

  it("shows nothing when the build was not stamped", async () => {
    renderWithBuild(null);
    await screen.findAllByRole("tab");
    expect(screen.queryByTestId("build-footer")).toBeNull();
  });
});
