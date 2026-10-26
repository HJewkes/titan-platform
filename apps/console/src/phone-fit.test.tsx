// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { staticSource, type Snapshot } from "@titan-design/rpc-client";
import { twinSnapshot } from "../server/twin/snapshot.js";
import { App } from "./App.js";

/*
 * jsdom lays nothing out, so these name the cap that keeps each item inside its wrapping row on a 390px phone.
 * server/twin/overflow.test.ts measures the real thing in Chromium.
 */

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
  window.location.hash = hash;
  render(
    <RpcProvider source={staticSource({ snapshot })}>
      <App />
    </RpcProvider>,
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

/** The ancestor of `element` (or itself) that sits directly in a wrapping flex row: the box a phone's width must bound. */
function rowItemOf(element: Element): Element | null {
  let node = element;
  for (let parent = node.parentElement; parent; node = parent, parent = parent.parentElement) {
    if (parent.classList.contains("flex-wrap")) return node;
  }
  return null;
}

/** Capped at the row's width by its own class or by an ancestor's arbitrary variant naming its testID. */
function isCappedToRow(element: Element): boolean {
  if (rowItemOf(element)?.classList.contains("max-w-full")) return true;
  const testId = element.getAttribute("data-testid");
  const variant = `[&_[data-testid=${testId}]]:max-w-full`;
  for (let node = element.parentElement; node; node = node.parentElement) if (testId && node.classList.contains(variant)) return true;
  return false;
}

describe("on a 390px phone", () => {
  it("wraps an initiative's long title inside the page instead of widening it", async () => {
    await renderAt("#/initiatives/orbit-relay");

    const title = screen.getByRole("heading", { name: "Orbit relay: message routing between stations" });
    expect(isCappedToRow(title)).toBe(true);
  });

  it("narrows each initiative card below its 326px width to fit the page", async () => {
    await renderAt("#/initiatives");

    const cards = [...document.querySelectorAll("[data-testid=initiative-card]")];
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.filter((card) => !isCappedToRow(card))).toEqual([]);
  });

  it("wraps a long upstream target inside its card instead of widening home", async () => {
    await renderAt("#/");

    const cards = [...document.querySelectorAll("[data-testid^=upstream-]")];
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.filter((card) => !isCappedToRow(card))).toEqual([]);
  });

  it("keeps the beat editor's fields, row buttons and save row inside the page", async () => {
    await renderAt("#/theater/v-relay-intro?t=2&edit=1");

    const editor = await screen.findByTestId("beat-editor");
    const rowItems = [...editor.querySelectorAll("button, input, h4")].filter((element) => rowItemOf(element) !== null);
    const fields = [...editor.querySelectorAll("[data-testid^=slot-]")].filter((element) => element.tagName !== "BUTTON");
    expect(rowItems.length).toBeGreaterThan(0);
    expect(rowItems.filter((element) => !isCappedToRow(element))).toEqual([]);
    expect(fields.filter((element) => !element.classList.contains("min-w-0") && !element.closest(".min-w-0"))).toEqual([]);
  });

  it("keeps the saved edits' rows and a note's Turn into edit inside the page", async () => {
    await renderAt("#/theater/v-relay-intro");

    const edits = await screen.findByTestId("theater-edits");
    const items = [...edits.querySelectorAll("[data-testid^=theater-edit-status-]"), await screen.findByTestId("theater-note-edit-0123456789abcdef")];
    expect(items.length).toBe(3);
    expect(items.filter((element) => !isCappedToRow(element))).toEqual([]);
  });
});
