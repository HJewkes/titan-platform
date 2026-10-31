// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SNAPSHOT_FORMAT, type Snapshot } from "@titan-design/rpc-client";
import { BELOW_MD } from "./pages/TasksPage.js";
import { renderPage, unmountPages } from "./render-page.test-helpers.js";
import { VIEWS } from "./views.js";

afterEach(async () => {
  await unmountPages();
  vi.unstubAllGlobals();
});

// No calls: the shell is under test, and every page shows its own empty or error state.
const EMPTY: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls: {} };

const onPhone = (): void =>
  void vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === BELOW_MD, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

const openMenu = (): HTMLElement => {
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  return screen.getByRole("navigation", { name: "Primary" });
};

describe("the shell nav on a phone", () => {
  it("hides the rail until the menu opens, then lists every route with the current one marked and focused", () => {
    onPhone();
    renderPage(EMPTY, "#/sessions", { inApp: true });
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();

    const links = within(openMenu()).getAllByRole("link");

    expect(links.map((link) => link.textContent)).toEqual(VIEWS.map((view) => view.title));
    expect(links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent)).toEqual(["Sessions"]);
    expect(document.activeElement?.textContent).toBe("Sessions");
    expect(links.every((link) => link.className.includes("min-h-11"))).toBe(true);
  });

  it("closes the menu once a route is tapped and lands on it", async () => {
    onPhone();
    renderPage(EMPTY, "#/", { inApp: true });

    fireEvent.click(within(openMenu()).getByRole("link", { name: "Theater" }));

    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    await waitFor(() => expect(window.location.hash).toBe("#/theater"));
  });

  it("closes the menu on Escape and hands focus back to the menu button", () => {
    onPhone();
    renderPage(EMPTY, "#/", { inApp: true });
    openMenu();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open navigation" }));
  });

  it("keeps the rail and no menu button on a desktop", () => {
    renderPage(EMPTY, "#/sessions", { inApp: true });

    expect(within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("button")).toHaveLength(VIEWS.length);
    expect(screen.queryByRole("button", { name: "Open navigation" })).toBeNull();
  });
});
