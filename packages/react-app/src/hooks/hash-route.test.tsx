// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { safeDecode, useHashRoute } from "./hash-route.js";

const parseView = (hash: string): { view: string } => ({ view: safeDecode(hash.replace(/^#\//, "")) || "home" });

function View() {
  return <p aria-label="view">{useHashRoute(parseView).view}</p>;
}

function setHash(hash: string): void {
  window.location.hash = hash;
  act(() => {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

beforeEach(() => {
  window.location.hash = "";
});
afterEach(cleanup);

describe("safeDecode", () => {
  it("decodes percent escapes", () => {
    expect(safeDecode("orbit%2Frelay%2312")).toBe("orbit/relay#12");
  });

  it("keeps a lone percent raw instead of throwing", () => {
    expect(safeDecode("50%")).toBe("50%");
  });
});

describe("useHashRoute", () => {
  it("parses the hash present at first render", () => {
    window.location.hash = "#/tasks";
    render(<View />);
    expect(screen.getByLabelText("view").textContent).toBe("tasks");
  });

  it("re-renders with the parsed route when the hash changes", () => {
    render(<View />);
    expect(screen.getByLabelText("view").textContent).toBe("home");
    setHash("#/sessions");
    expect(screen.getByLabelText("view").textContent).toBe("sessions");
  });

  it("stops listening once unmounted", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<View />);
    unmount();
    expect(remove).toHaveBeenCalledWith("hashchange", expect.any(Function));
    remove.mockRestore();
  });
});
