// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { staticSource, type Snapshot } from "@titan-design/rpc-client";
import { TWIN_ROUTES } from "../server/twin/routes.js";
import { twinSnapshot } from "../server/twin/snapshot.js";
import { App } from "./App.js";

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

/** Text the shell draws around the routed view, so whatever is left belongs to the view. */
function textOutsideMain(main: HTMLElement): string {
  return [...(main.parentElement?.children ?? [])]
    .filter((sibling) => sibling !== main)
    .map((sibling) => sibling.textContent)
    .join("");
}

describe("the page shell", () => {
  it.each(TWIN_ROUTES)("puts $name inside one Page", async ({ hash }) => {
    await renderAt(hash);

    const [main, ...more] = screen.getAllByRole("main");
    expect(more).toHaveLength(0);
    expect(main!.textContent).not.toBe("");
    expect(textOutsideMain(main!)).toBe("");
  });

  it("titles a list view with its rail entry's title", async () => {
    await renderAt("#/rounds");

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Review rounds");
  });

  it("leaves a detail view's title to the view, under its own trail", async () => {
    await renderAt("#/tasks/OR-12");

    const titles = screen.queryAllByRole("heading", { level: 1 }).map((heading) => heading.textContent);
    expect(titles).not.toContain("Tasks");
  });
});
