// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS as source } from "../server/round-fixtures.js";
import { getRound } from "../server/rounds.js";
import { App } from "./App.js";
import { onSection, shownSection, stubScroll, toSection } from "./pages/round-pager.test-helpers.js";

const PAGED = "kiln-schedule-r2";
const RAMP = "Which ramp should the calculator propose by default?";

class NoObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  stubScroll();
  vi.stubGlobal("IntersectionObserver", NoObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The daemon's answers over the synthetic fixtures this file opens. */
async function recorded(ids: readonly string[]): Promise<Snapshot> {
  const rounds = await Promise.all(ids.map(async (id) => [snapshotKey("rounds.get", { id }), successEnvelope(await getRound(source, id))] as const));
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: { ...Object.fromEntries(rounds), [snapshotKey("rounds.frames", { id: "ship-tile-r1" })]: successEnvelope({ frames: [] }) },
  };
}

/** Opens `hash` as a fresh page load would. */
async function load(hash: string, ids: readonly string[] = [PAGED]): Promise<void> {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", await recorded(ids)), "text/html");
  window.location.hash = hash;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
  await screen.findByText(/round \d/);
}

const position = (): string | null => screen.getByTestId("section-position").textContent;
const jumpMark = (id: string): string | null => screen.getByTestId(`section-jump-${id}`).textContent;
const endNext = (): HTMLElement => screen.getByTestId("section-next-end");
const pick = (questionId: string, label: string): void => {
  const control = within(screen.getByTestId(`round-question-${questionId}`)).getByText(label).closest<HTMLElement>('[role="radio"], [role="checkbox"]');
  if (!control) throw new Error(`no control labelled ${label}`);
  fireEvent.click(control);
};
const isDisabled = (button: HTMLElement): boolean => button.getAttribute("aria-disabled") === "true";

describe("a round of several sections", () => {
  it("shows one section at a time, and Next and Back step between them", async () => {
    await load(`#/rounds/${PAGED}`);

    expect(position()).toBe("Section 1 of 2: Firing ramp");
    expect(screen.getByTestId("round-question-ramp-default")).toBeTruthy();
    expect(screen.queryByTestId("round-question-report-columns")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();

    fireEvent.click(endNext());
    await onSection("report");

    expect(position()).toBe("Section 2 of 2: Printed report");
    expect(screen.queryByTestId("round-question-ramp-default")).toBeNull();
    expect(screen.getByTestId("round-question-report-columns")).toBeTruthy();
    expect(isDisabled(endNext())).toBe(true);
    expect(screen.getByRole("button", { name: "Send answers" })).toBeTruthy();

    fireEvent.click(within(screen.getByTestId("section-steps")).getByText("← Back"));
    await onSection("ramp");
    expect(position()).toBe("Section 1 of 2: Firing ramp");
  });

  it("marks each section in the jump list as unanswered, partly answered or answered", async () => {
    await load(`#/rounds/${PAGED}`);
    expect(jumpMark("ramp")).toBe("1. Firing ramp · unanswered");

    pick("ramp-default", "1 Staged climb");
    expect(jumpMark("ramp")).toBe("1. Firing ramp · 1 of 2 answered");

    pick("hold-clarity", "4 4");
    expect(jumpMark("ramp")).toBe("✓ 1. Firing ramp · answered");
    expect(jumpMark("report")).toBe("2. Printed report · unanswered");
  });

  it("keeps the section in the URL, so a reload opens the same one", async () => {
    await load(`#/rounds/${PAGED}`);
    await toSection("report");
    const hash = window.location.hash;
    expect(hash).toBe(`#/rounds/${PAGED}?section=report`);
    cleanup();

    await load(hash);

    expect(shownSection()).toBe("report");
    expect(position()).toBe("Section 2 of 2: Printed report");
  });

  it("opens the first section for a section the round does not have", async () => {
    await load(`#/rounds/${PAGED}?section=nowhere`);
    expect(shownSection()).toBe("ramp");
  });

  it("steps with n and p, but not while typing or with a modifier held", async () => {
    await load(`#/rounds/${PAGED}`);

    // The page's own text boxes stop their key events before they reach the window, so a plain field is what the guard is for.
    const field = document.body.appendChild(document.createElement("input"));
    fireEvent.keyDown(field, { key: "n" });
    fireEvent.keyDown(screen.getByLabelText(`Comment on ${RAMP}`), { key: "n" });
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    field.remove();
    expect(window.location.hash).toBe(`#/rounds/${PAGED}`);
    expect(shownSection()).toBe("ramp");

    fireEvent.keyDown(window, { key: "n" });
    await onSection("report");
    fireEvent.keyDown(window, { key: "p" });
    await onSection("ramp");
  });

  it("moves focus to Next once the section's last open question is answered", async () => {
    await load(`#/rounds/${PAGED}`);

    pick("ramp-default", "1 Staged climb");
    expect(document.activeElement).not.toBe(endNext());

    pick("hold-clarity", "3 3");
    expect(document.activeElement).toBe(endNext());
  });

  it("leaves focus in a text answer that completes its section", async () => {
    await load(`#/rounds/${PAGED}?section=report`);
    pick("report-columns", "1 Segment");
    const box = screen.getByLabelText<HTMLTextAreaElement>("Answer to Anything else the report should say?");
    box.focus();

    fireEvent.change(box, { target: { value: "A" } });

    expect(jumpMark("report")).toBe("✓ 2. Printed report · answered");
    expect(document.activeElement).toBe(box);
  });
});

describe("a round the pager leaves as one page", () => {
  it("draws a one-section round with no pager and its send state below the question", async () => {
    await load("#/rounds/kiln-schedule-r1", ["kiln-schedule-r1"]);
    await screen.findByTestId("round-question-unit-start");

    expect(screen.queryByTestId("section-pager")).toBeNull();
    expect(screen.getByText("Answers sent")).toBeTruthy();
  });

  it("keeps a Ship round's Ship card after every question, whatever its sections", async () => {
    await load("#/rounds/ship-tile-r1", ["ship-tile-r1"]);
    const ship = await screen.findByRole("button", { name: "Ship" });

    expect(screen.queryByTestId("section-pager")).toBeNull();
    const side = screen.getByTestId("ship-side-badge-follow-up");
    expect(side.compareDocumentPosition(ship) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("a sent round of several sections", () => {
  it("pages read-only", async () => {
    const round = await getRound(source, PAGED);
    if (!round.valid) throw new Error(round.reason);
    const sent = { ...round, status: "sent" as const, notes: { general: "", comments: {}, answers: { "report-columns": { picks: ["Segment"] } }, addressed: [] } };
    const page = new DOMParser().parseFromString(
      embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls: { [snapshotKey("rounds.get", { id: PAGED })]: successEnvelope(sent) } }),
      "text/html",
    );
    window.location.hash = `#/rounds/${PAGED}`;
    render(
      <RpcProvider source={pageDataSource({ doc: page })}>
        <App />
      </RpcProvider>,
    );
    await screen.findByTestId("round-question-ramp-default");

    fireEvent.click(endNext());
    await onSection("report");

    expect(screen.getByTestId("round-entry-report-columns").hasAttribute("inert")).toBe(true);
    expect(jumpMark("report")).toBe("2. Printed report · 1 of 2 answered");
    await waitFor(() => expect(screen.getByText("Answers sent")).toBeTruthy());
  });
});
