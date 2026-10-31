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

type Shipped = ServedCommands["coord.shipped"]["result"];

// Synthetic initiatives and PRs only.
const DATE = "2031-03-04";
const pr = (repo: string, number: number, task: string) => ({ repo, number, task, initiative: "harbor", url: `https://github.com/${repo}/pull/${number}` });
const DOCK = pr("harbor/dock", 7, "HB-7");
const QUAY = pr("harbor/quay", 9, "HB-9");

const BUILT: Shipped = {
  date: DATE,
  built: true,
  stale: false,
  digest: { v: 1, date: DATE, builtAt: "2031-03-05T07:10:00.000Z", prSetHash: "h", groups: [{ initiative: "harbor", themes: [{ title: "Docks index", summary: "The dock index now lists every berth.", prs: [DOCK] }], unsummarized: [QUAY] }] },
  merged: [DOCK, QUAY],
};
const UNBUILT: Shipped = { date: DATE, built: false, stale: false, digest: null, merged: [DOCK] };
const EMPTY: Shipped = { date: DATE, built: false, stale: false, digest: null, merged: [] };

function pageWith(shipped: Shipped): void {
  const snapshot: Snapshot = {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: {
      [snapshotKey("coord.pools", {})]: successEnvelope({ date: DATE, from: "2031-03-04T07:00:00.000Z", to: "2031-03-05T07:00:00.000Z", accounts: [], gaps: [] }),
      [snapshotKey("coord.cards", {})]: successEnvelope({ date: DATE, cards: [], unattributed: [], gaps: [] }),
      [snapshotKey("coord.shipped", {})]: successEnvelope(shipped),
    },
  };
  renderPage(snapshot, "#/coordinator");
}

const onPhone = (): void =>
  void vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === BELOW_MD, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

describe("what shipped on the coordinator page", () => {
  it("shows each theme with its summary and PR links, and the PRs left out of a theme", async () => {
    pageWith(BUILT);

    const theme = await screen.findByTestId("coord-shipped-theme-Docks index");
    expect(within(theme).getByText("The dock index now lists every berth.")).toBeTruthy();
    expect(within(theme).getByTestId("coord-shipped-pr-harbor/dock#7").closest("a")?.getAttribute("href")).toBe(DOCK.url);
    expect(within(screen.getByTestId("coord-shipped-unsummarized-harbor")).getByTestId("coord-shipped-pr-harbor/quay#9")).toBeTruthy();
    expect(screen.queryByTestId("coord-shipped-unbuilt")).toBeNull();
  });

  it("warns that the digest is stale when the merged set changed after it was built", async () => {
    pageWith({ ...BUILT, stale: true });

    expect(await screen.findByTestId("coord-shipped-stale")).toBeTruthy();
  });

  it("says no digest is built, names the 07:10 timer, and lists the merged PRs", async () => {
    pageWith(UNBUILT);

    const note = await screen.findByTestId("coord-shipped-unbuilt");
    expect(note.textContent).toContain("No digest has been built for this day yet");
    expect(note.textContent).toContain("07:10 timer");
    expect(screen.getByTestId("coord-shipped-pr-harbor/dock#7")).toBeTruthy();
    expect(screen.queryByTestId("coord-shipped-theme-Docks index")).toBeNull();
  });

  it("says Shepherd merged nothing on an empty day", async () => {
    pageWith(EMPTY);

    expect((await screen.findByTestId("coord-shipped-empty")).textContent).toContain("merged no PR");
    expect(screen.queryByTestId("coord-shipped-unbuilt")).toBeNull();
  });

  it("gives the PR links a 44px target on a narrow viewport", async () => {
    onPhone();
    pageWith(BUILT);

    expect((await screen.findByTestId("coord-shipped-pr-harbor/dock#7")).className).toContain("max-md:min-h-11");
  });
});
