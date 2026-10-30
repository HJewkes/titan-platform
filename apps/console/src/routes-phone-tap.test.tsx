// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import type { Snapshot } from "@titan-design/rpc-client";
import { twinSnapshot } from "../server/twin/snapshot.js";
import { renderPage } from "./render-page.test-helpers.js";

/*
 * jsdom lays nothing out, so these name the phone-only class that gives each press target its 44px; the measured sizes
 * at 375 and 390 px come from Chromium and go with the PR's shots.
 */

const PHONE_TAP = "max-md:min-h-11";

/** react-ui's `Link` puts its class on the text inside the pressable that carries the link role, and that text sizes the pressable. */
const carriesTap = (link: Element): boolean => link.className.includes(PHONE_TAP) || link.querySelector(`[class*="${PHONE_TAP}"]`) !== null;

let snapshot: Snapshot;

beforeAll(async () => {
  snapshot = await twinSnapshot();
});

class SeeNothing {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", SeeNothing));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderAt(hash: string): Promise<void> {
  renderPage(snapshot, hash);
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

describe("a press target on a phone", () => {
  it("gives each initiative's link a 44px tap", async () => {
    await renderAt("#/initiatives");

    const row = await screen.findByTestId("initiative-row-orbit-relay");
    expect(carriesTap(within(row).getByRole("link", { name: "orbit-relay" }))).toBe(true);
  });

  it("gives the initiative's breadcrumb, record tabs and brief steps a 44px tap", async () => {
    await renderAt("#/initiatives/orbit-relay");

    expect((await screen.findByText("Initiatives")).closest(`[class*="${PHONE_TAP}"]`)).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Tasks (3)" }).className).toContain(PHONE_TAP);
    expect(screen.getByTestId("initiative-brief").className).toContain("max-md:[&_button]:min-h-11");
  });

  it("gives the review findings' filter chips a 44px tap", async () => {
    await renderAt("#/reviews/widget-kit");

    const chip = await screen.findByRole("button", { name: "P3" });
    expect(chip.className).toContain(PHONE_TAP);
    expect(chip.className).toContain("max-md:min-w-11");
  });

  it("gives config's tabs a 44px tap", async () => {
    await renderAt("#/config");

    expect((await screen.findByRole("tab", { name: "Settings" })).className).toContain(PHONE_TAP);
    expect(screen.getByRole("tab", { name: "Perf" }).className).toContain(PHONE_TAP);
  });

  it("gives each shepherd run's link a 44px tap", async () => {
    await renderAt("#/shepherd");

    const links = await screen.findAllByRole("link", { name: "orbit/relay#12" });
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((link) => !carriesTap(link))).toEqual([]);
  });
});
