// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, staticSource } from "@titan-design/rpc-client";
import { BlockerBanner } from "./BlockerBanner.js";

const DEPOSIT_ID = `deposit:${"c3".repeat(16)}`;
const GATE_ID = "gate:5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d/approve-merge";

function banner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { thresholdHours: 12, count: 0, items: [], gaps: [], ...overrides };
}

const inboxBlocker = {
  id: DEPOSIT_ID,
  source: "blocker",
  summary: "Publish the new package by hand",
  blocks: "example/repo#41",
  asker: "worker-one",
  since: "2031-03-01T00:00:00.000Z",
  ageHours: 30.5,
  link: `#/inbox/${encodeURIComponent(DEPOSIT_ID)}`,
};
const ownerGate = {
  id: GATE_ID,
  source: "owner-gate",
  summary: "example/repo#12 waits on approve-merge",
  blocks: "example/repo#12",
  asker: "shepherd",
  since: "2031-02-27T00:00:00.000Z",
  ageHours: 148,
  link: `#/inbox/${encodeURIComponent(GATE_ID)}`,
};

function renderBanner(result: Record<string, unknown>): void {
  const calls = { [snapshotKey("blockers.banner", {})]: successEnvelope(result) };
  render(
    <RpcProvider source={staticSource({ snapshot: { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T12:00:00.000Z", calls } })}>
      <BlockerBanner />
    </RpcProvider>,
  );
}

afterEach(cleanup);

describe("blocker banner", () => {
  it("no blockers renders nothing", async () => {
    renderBanner(banner());

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("blocker-banner")).toBeNull();
  });

  it("two blocker classes render two collapsed lines with count and oldest age", async () => {
    renderBanner(banner({ count: 2, items: [ownerGate, inboxBlocker] }));

    const inbox = await screen.findByTestId("blocker-line-inbox");
    const shepherd = screen.getByTestId("blocker-line-shepherd");
    expect(inbox.textContent).toBe("Inbox blockers: 1 · oldest 30.5 h");
    expect(shepherd.textContent).toBe("Shepherd waits: 1 · oldest 148 h");
  });

  it("an item links to #/inbox/<id>", async () => {
    renderBanner(banner({ count: 1, items: [inboxBlocker] }));

    fireEvent.click(await screen.findByTestId("blocker-line-inbox"));

    const link = await waitFor(() => screen.getByTestId(`blocker-item-${DEPOSIT_ID}`));
    const anchor = link.closest("a") ?? within(link).getByRole("link");
    expect(anchor.getAttribute("href")).toBe(`#/inbox/${encodeURIComponent(DEPOSIT_ID)}`);
  });

  it("on a phone the banner fits one line per class", async () => {
    renderBanner(banner({ count: 2, items: [ownerGate, inboxBlocker] }));

    for (const key of ["inbox", "shepherd"]) {
      const line = (await screen.findByTestId(`blocker-line-${key}`)).classList;
      expect([line.contains("truncate"), line.contains("whitespace-nowrap"), line.contains("max-w-full")]).toEqual([true, true, true]);
    }
  });
});
