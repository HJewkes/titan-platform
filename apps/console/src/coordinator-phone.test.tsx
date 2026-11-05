// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import type { ServedCommands } from "./data/rpc.js";
import { BELOW_MD } from "./pages/phone.js";
import { renderPage } from "./render-page.test-helpers.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Cards = ServedCommands["coord.cards"]["result"];

// Synthetic coordinators and PRs only.
const CARDS: Cards = {
  date: "2031-03-04",
  cards: [{ coordinator: "harbor-coord", seat: null, agentsRun: 2, liveNow: 0, costUsd: 1, prsMerged: [{ repo: "harbor/dock", number: 7, task: "HB-7", initiative: "harbor", url: "https://github.com/harbor/dock/pull/7" }], tasks: [{ id: "HB-7" }] }],
  unattributed: [],
  gaps: [],
};

const SNAPSHOT: Snapshot = {
  format: SNAPSHOT_FORMAT,
  createdAt: "2031-03-05T00:00:00.000Z",
  calls: {
    [snapshotKey("coord.pools", {})]: successEnvelope({ date: "2031-03-04", from: "2031-03-04T07:00:00.000Z", to: "2031-03-05T07:00:00.000Z", accounts: [], gaps: [] }),
    [snapshotKey("coord.cards", {})]: successEnvelope(CARDS),
    [snapshotKey("coord.shipped", {})]: successEnvelope({ date: "2031-03-04", built: false, stale: false, digest: null, merged: [] }),
  },
};

const onPhone = (): void =>
  void vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === BELOW_MD, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

describe("the coordinator page on a phone", () => {
  it("stacks the coordinator cards and gives PR and task links a 44px target", async () => {
    onPhone();
    renderPage(SNAPSHOT, "#/coordinator");

    const card = await screen.findByTestId("coord-card-harbor-coord");
    expect(screen.getByTestId("coord-cards-stack")).toBeTruthy();
    expect(screen.queryByTestId("coord-cards-grid")).toBeNull();
    expect(within(card).getByTestId("coord-pr-harbor/dock#7").className).toContain("max-md:min-h-11");
    expect(within(card).getByText("HB-7", { selector: "[class*='max-md:min-w-11']" })).toBeTruthy();
  });

  it("gives the day buttons a 44px target", async () => {
    onPhone();
    renderPage(SNAPSHOT, "#/coordinator");

    expect((await screen.findByTestId("coord-day-previous")).className).toContain("max-md:min-h-11");
  });

  it("lays the cards out in a grid on a desktop", async () => {
    renderPage(SNAPSHOT, "#/coordinator");

    expect(await screen.findByTestId("coord-cards-grid")).toBeTruthy();
    expect(screen.queryByTestId("coord-cards-stack")).toBeNull();
  });
});
