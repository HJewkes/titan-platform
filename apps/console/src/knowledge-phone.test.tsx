// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { Snapshot } from "@titan-design/rpc-client";
import { twinSnapshot } from "../server/twin/snapshot.js";
import { BELOW_MD } from "./pages/phone.js";
import { renderPage, unmountPages } from "./render-page.test-helpers.js";

/*
 * jsdom lays nothing out, so these check the layout a phone gets and the classes that size it;
 * server/twin/overflow.test.ts measures the real pages in Chromium.
 */

const NOTE = "note:orbit-relay/2031-03-03-backoff-ceiling.md";

let snapshot: Snapshot;

beforeAll(async () => {
  snapshot = await twinSnapshot();
});

afterEach(async () => {
  await unmountPages();
  vi.unstubAllGlobals();
});

const onPhone = (): void =>
  void vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === BELOW_MD, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

describe("the knowledge list on a phone", () => {
  it("stacks each note into a two-line card of its title, then kind, initiative and date, instead of the table", async () => {
    onPhone();
    renderPage(snapshot, "#/knowledge");

    const card = within(await screen.findByTestId(`knowledge-card-${NOTE}`));
    expect(screen.queryAllByTestId(/^knowledge-row-/)).toEqual([]);
    for (const text of ["Cap the backoff at thirty seconds", "note", "decision", "orbit-relay"]) expect(card.getByText(text)).toBeTruthy();
    expect(card.queryByText(/backoff-ceiling\.md/)).toBeNull();
    const lines = screen.getByTestId(`knowledge-card-${NOTE}`).children;
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(screen.getByTestId(`knowledge-card-meta-${NOTE}`));
    expect(within(screen.getByTestId(`knowledge-card-meta-${NOTE}`)).getByText("orbit-relay")).toBeTruthy();
  });

  it("gives each card's title and initiative links a 44px tap target", async () => {
    onPhone();
    renderPage(snapshot, "#/knowledge");

    const card = within(await screen.findByTestId(`knowledge-card-${NOTE}`));
    expect(card.getByText("Cap the backoff at thirty seconds").className).toContain("min-h-11");
    expect(card.getByText("orbit-relay").className).toContain("min-h-11");
  });

  it("keeps the table on a desktop", async () => {
    renderPage(snapshot, "#/knowledge");

    expect(await screen.findByTestId(`knowledge-row-${NOTE}`)).toBeTruthy();
    expect(screen.queryAllByTestId(/^knowledge-card-/)).toEqual([]);
  });
});

describe("a knowledge record on a phone", () => {
  it("lets its long ref break inside the breadcrumb instead of widening the page", async () => {
    renderPage(snapshot, `#/knowledge/${encodeURIComponent(NOTE)}`);

    // The record read is still loading once the breadcrumb shows; ending the test there leaves its resolution and re-render queued (TP-4784).
    await screen.findByTestId("knowledge-body");
    const crumb = screen.getAllByText(NOTE)[0]!;
    const wrapper = crumb.closest(".break-all");
    expect(wrapper?.classList.contains("[&_*]:shrink")).toBe(true);
  });
});
