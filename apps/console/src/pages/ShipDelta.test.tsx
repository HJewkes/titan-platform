// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey } from "@titan-design/rpc-client";
import type { FrameDelta } from "../../server/round-frame-delta.js";
import { FIXTURE_ROUNDS } from "../../server/round-fixtures.js";
import { getRound } from "../../server/rounds.js";
import { DeltaPanel, formatShare } from "./ShipDelta.js";
import { Montages } from "./ShipMontages.js";

/** Every panel nears the viewport as soon as it is observed. */
class NearObserver {
  constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe(): void {
    this.callback([{ isIntersecting: true }]);
  }
  disconnect(): void {}
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", NearObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROUND = "ship-tile-r1";
const KEY = "tile-light";

function renderDelta(delta: FrameDelta): void {
  const calls = { [snapshotKey("rounds.frameDelta", { id: ROUND, key: KEY })]: successEnvelope(delta) };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls }), "text/html");
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <DeltaPanel roundId={ROUND} frameKey={KEY} label="Tile" />
    </RpcProvider>,
  );
}

describe("the Diff tab's delta panel", () => {
  it("draws the delta image with the share of the content that changed", async () => {
    renderDelta({ status: "changed", changedPixels: 1, share: 1 / 16, width: 10, height: 10, contentType: "image/png", bytes: 8, sha256: "0".repeat(64), base64: "iVBORw0KGgo=" });

    const panel = within(screen.getByTestId(`delta-${KEY}`));
    const image = await panel.findByRole("img", { name: "Tile, pixels changed from main to head" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(panel.getByTestId("delta-share").textContent).toBe("6.3% of the content changed (1 pixel)");
  });

  it("says the sizes differ instead of drawing a delta", async () => {
    renderDelta({ status: "sizesDiffer", base: { width: 10, height: 10 }, head: { width: 12, height: 10 } });

    expect((await screen.findByTestId("delta-sizes-differ")).textContent).toContain("Sizes differ: main is 10×10, head is 12×10");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("says no pixels moved when the server finds main and head the same", async () => {
    renderDelta({ status: "unchanged" });

    expect(await screen.findByText("No pixels moved.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("the Diff tab's montages", () => {
  const FRAMES = [
    { key: "tile-light", theme: "light", views: ["head", "base", "diff"], indexed: true, unchanged: true },
    { key: "tile-dark", theme: "dark", views: ["head", "base", "diff"], indexed: true, unchanged: false },
    { key: "panel-wide", theme: "light", views: ["head", "base"], indexed: true, unchanged: false },
    { key: "badge-new", views: ["head"], indexed: false, unchanged: false },
  ];

  async function renderMontages(): Promise<void> {
    const round = await getRound(FIXTURE_ROUNDS, ROUND);
    if (!round.valid) throw new Error("fixture round is invalid");
    const calls = { [snapshotKey("rounds.frames", { id: ROUND })]: successEnvelope({ indexed: true, frames: FRAMES }) };
    const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls }), "text/html");
    render(<RpcProvider source={pageDataSource({ doc: page })}><Montages round={round} /></RpcProvider>);
    await screen.findAllByTestId(/^montage-/);
  }

  it("gives each changed pair a delta panel, with or without a packet diff", async () => {
    await renderMontages();

    expect(within(screen.getByTestId("montage-tile-dark")).getByTestId("delta-tile-dark")).toBeTruthy();
    expect(within(screen.getByTestId("montage-panel-wide")).getByTestId("delta-panel-wide")).toBeTruthy();
  });

  it("gives an unchanged frame and a new one no delta panel", async () => {
    await renderMontages();

    expect(within(screen.getByTestId("montage-tile-light")).queryByTestId("delta-tile-light")).toBeNull();
    expect(within(screen.getByTestId("montage-badge-new")).queryByTestId("delta-badge-new")).toBeNull();
  });
});

describe("formatShare", () => {
  it("rounds to one place and keeps a tiny change visible", () => {
    expect([formatShare(0), formatShare(0.0004), formatShare(0.0625), formatShare(1)]).toEqual(["0%", "<0.1%", "6.3%", "100%"]);
  });
});
