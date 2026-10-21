// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InlineMarkdown, RoundProse, plainText } from "./RoundMarkdown.js";

const opened = vi.fn();

beforeEach(() => vi.stubGlobal("open", opened));
afterEach(() => {
  cleanup();
  opened.mockReset();
  vi.unstubAllGlobals();
});

describe("RoundProse", () => {
  it("renders bold and an https link, and the link opens its target", () => {
    render(<RoundProse text="The **ramp** moved; see [the notes](https://example.test/kiln)." />);

    expect(screen.getByText("ramp")).toBeTruthy();
    expect(screen.queryByText(/\*\*/)).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "the notes" }));

    expect(opened).toHaveBeenCalledWith("https://example.test/kiln", "_blank", "noopener");
  });

  it("links a relative target and a mailto", () => {
    render(<RoundProse text="[spec](docs/kiln.md) or [ask](mailto:kiln@example.test)" />);

    expect(screen.getByRole("link", { name: "spec" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "ask" })).toBeTruthy();
  });

  it("neutralises a javascript: link: its text shows, nothing links and nothing opens", () => {
    render(<RoundProse text="[click me](javascript:alert(1)) and [also](JavaScript:void0)" />);

    fireEvent.click(screen.getByText("also"));

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/javascript/i)).toBeNull();
    expect(opened).not.toHaveBeenCalled();
  });
});

describe("InlineMarkdown", () => {
  it("renders bold, code and a safe link inside the caller's text", () => {
    const { container } = render(<span>{<InlineMarkdown text="Keep **staged** at `cone 6`? [why](https://example.test/why)" />}</span>);

    expect(container.querySelector("strong")?.textContent).toBe("staged");
    expect(container.querySelector("code")?.textContent).toBe("cone 6");
    expect(screen.getByRole("link", { name: "why" })).toBeTruthy();
  });

  it("shows a javascript: link as its text alone", () => {
    render(<span><InlineMarkdown text="Pick [this](javascript:alert(1))" /></span>);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Pick this")).toBeTruthy();
  });

  it("gives plain text back unchanged", () => {
    const { container } = render(<span><InlineMarkdown text="Staged climb" /></span>);

    expect(container.innerHTML).toBe("<span>Staged climb</span>");
  });
});

describe("plainText", () => {
  it("drops the markup and keeps the words", () => {
    expect(plainText("**Ring** with `glow` per [spec](https://example.test)")).toBe("Ring with glow per spec");
  });
});
