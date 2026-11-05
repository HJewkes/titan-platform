// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS as source } from "../server/round-fixtures.js";
import { getRound } from "../server/rounds.js";
import { onSection, shownSection, stubScroll } from "./pages/round-pager.test-helpers.js";
import { ROUND_KEYS } from "./pages/round-keys.js";
import { renderPage } from "./render-page.test-helpers.js";

const ROUND = "kiln-schedule-r2";

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
  localStorage.clear();
  vi.unstubAllGlobals();
});

/** Renders the synthetic paged round over a recorded snapshot, with a live answer source so it can be sent. */
async function renderRound({ inApp = false } = {}): Promise<void> {
  const round = await getRound(source, ROUND);
  const snapshot: Snapshot = {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: { [snapshotKey("rounds.get", { id: ROUND })]: successEnvelope(round), [snapshotKey("rounds.list", {})]: successEnvelope({ rounds: [], truncated: false, dir: "/state/rounds" }) },
  };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  const live = pageDataSource({ doc: page });
  renderPage(live, `#/rounds/${ROUND}`, { answers: live, inApp });
  await screen.findByTestId("round-question-ramp-default");
  await act(async () => undefined);
}

const pick = (questionId: string, label: string): void => {
  const control = within(screen.getByTestId(`round-question-${questionId}`)).getByText(label).closest<HTMLElement>('[role="radio"], [role="checkbox"]');
  if (!control) throw new Error(`no control labelled ${label}`);
  fireEvent.click(control);
};

/** The question the digit keys answer, read from its "keys 1-9 answer" caption. */
const activeQuestion = (): string | undefined =>
  screen.getByText(`keys ${ROUND_KEYS.pick.label} answer`).closest<HTMLElement>('[data-testid^="round-question-"]')?.dataset.testid?.replace("round-question-", "");

const settle = (): Promise<void> => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

describe("Enter on a round", () => {
  it("goes to the next unanswered question, across sections", async () => {
    await renderRound({ inApp: true });
    pick("ramp-default", "1 Staged climb");

    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(activeQuestion()).toBe("hold-clarity"));

    pick("hold-clarity", "3 3");
    fireEvent.keyDown(document.body, { key: "Enter" });
    await onSection("report");
    await waitFor(() => expect(activeQuestion()).toBe("report-columns"));
  });

  it("is ignored while typing, with a modifier it does not own, and on a focused button", async () => {
    await renderRound();
    pick("ramp-default", "1 Staged climb");
    // The page's own text boxes stop their key events before they reach the window, so a plain field is what the guard is for.
    const field = document.body.appendChild(document.createElement("input"));
    const button = document.body.appendChild(document.createElement("button"));

    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    await settle();
    field.remove();
    button.remove();

    expect(activeQuestion()).toBe("ramp-default");
    expect(shownSection()).toBe("ramp");
  });

  it("opens the check screen once no question is left open", async () => {
    await renderRound();
    pick("ramp-default", "1 Staged climb");
    pick("hold-clarity", "3 3");
    fireEvent.click(screen.getByTestId("section-next-end"));
    await onSection("report");
    pick("report-columns", "1 Segment");
    fireEvent.change(screen.getByLabelText("Answer to Anything else the report should say?"), { target: { value: "Add the cone number." } });

    fireEvent.keyDown(window, { key: "Enter" });

    expect(await screen.findByTestId("round-check")).toBeTruthy();
  });
});

describe("Cmd or Ctrl + Enter on a round", () => {
  it("opens the check-before-send screen from any section, but not from a field", async () => {
    await renderRound();
    const field = document.body.appendChild(document.createElement("textarea"));
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await settle();
    field.remove();
    expect(screen.queryByTestId("round-check")).toBeNull();

    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });

    expect(await screen.findByTestId("round-check")).toBeTruthy();
    expect(screen.getByTestId("round-check-unanswered").textContent).toContain("4 of 4 questions are unanswered");
  });
});

describe("the key legend", () => {
  it("opens with ? and lists every round key, the existing ones included", async () => {
    await renderRound();
    expect(screen.queryByTestId("round-key-legend")).toBeNull();

    fireEvent.keyDown(window, { key: "?", shiftKey: true });

    const legend = within(await screen.findByTestId("round-key-legend"));
    for (const binding of Object.values(ROUND_KEYS)) expect(legend.getByText(binding.does)).toBeTruthy();
    for (const existing of ["[", "]", "n", "p", "1-9", "r", "c", "a", "⌘ or Ctrl + Enter"]) expect(legend.getAllByText(existing).length).toBeGreaterThan(0);
  });

  it("opens from the Keys button, and ? is ignored while typing", async () => {
    await renderRound();
    const field = document.body.appendChild(document.createElement("input"));
    fireEvent.keyDown(field, { key: "?", shiftKey: true });
    await settle();
    field.remove();
    expect(screen.queryByTestId("round-key-legend")).toBeNull();

    fireEvent.click(screen.getByTestId("round-keys-toggle"));

    expect(await screen.findByTestId("round-key-legend")).toBeTruthy();
  });
});
