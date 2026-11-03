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
  it("stacks each note into a card with its title, kind, initiative and file instead of the table", async () => {
    onPhone();
    renderPage(snapshot, "#/knowledge");

    const card = within(await screen.findByTestId(`knowledge-card-${NOTE}`));
    expect(screen.queryAllByTestId(/^knowledge-row-/)).toEqual([]);
    for (const text of ["Cap the backoff at thirty seconds", "note", "decision", "orbit-relay"]) expect(card.getByText(text)).toBeTruthy();
    expect(card.getByText(/backoff-ceiling\.md/)).toBeTruthy();
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

    const crumb = (await screen.findAllByText(NOTE))[0]!;
    const wrapper = crumb.closest(".break-all");
    expect(wrapper?.classList.contains("[&_*]:shrink")).toBe(true);
  });
});
