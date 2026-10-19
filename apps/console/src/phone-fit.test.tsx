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

    const title = screen.getByRole("heading", { level: 1 });
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
});
