// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS as source } from "../server/round-fixtures.js";
import { getRound } from "../server/rounds.js";
import { App } from "./App.js";
import { toSection } from "./pages/round-pager.test-helpers.js";

// An unsent round keeps its draft in localStorage, so each test starts from none.
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const ROUND = "kiln-schedule-r2";
const NOTES = "Anything else the report should say?";

async function renderRound(): Promise<void> {
  const round = await getRound(source, ROUND);
  if (!round.valid) throw new Error(round.reason);
  const snapshot: Snapshot = {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: { [snapshotKey("rounds.get", { id: ROUND })]: successEnvelope(round), [snapshotKey("rounds.list", {})]: successEnvelope({ rounds: [], truncated: false, dir: "/state/rounds" }) },
  };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  window.location.hash = `#/rounds/${ROUND}`;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
  await screen.findByTestId("round-question-ramp-default");
}

/** A class that moves the element while it is pressed or hovered; the browser's :active also holds on every ancestor of the pressed node. */
const MOVES_ON_PRESS = /(^|:)(active|hover):-?(scale|translate)-/;
const pressMotion = (element: Element): string[] => [...element.classList].filter((name) => MOVES_ON_PRESS.test(name));

/** Every press motion that a press on `target` sets off: its own and its ancestors'. */
function motionAround(target: Element): string[] {
  const found: string[] = [];
  for (let at: Element | null = target; at; at = at.parentElement) found.push(...pressMotion(at));
  return found;
}

const radio = (label: string): HTMLElement => {
  const found = within(screen.getByTestId("round-question-ramp-default")).getByText(label).closest<HTMLElement>('[role="radio"]');
  if (!found) throw new Error(`no radio labelled ${label}`);
  return found;
};

describe("pressing on the rounds screen", () => {
  it("selects a radio on the first click, and neither the question card nor the option moves", async () => {
    await renderRound();

    fireEvent.click(radio("2 Single slope"));

    expect(radio("2 Single slope").getAttribute("aria-checked")).toBe("true");
    expect(motionAround(radio("2 Single slope"))).toEqual([]);
    expect(screen.getByTestId("round-question-ramp-default").closest('[role="button"]')).toBeNull();
  });

  it("puts no press on anything while a space is typed in a question's own text field", async () => {
    await renderRound();
    await toSection("report");
    const field = within(screen.getByTestId("round-question-report-notes")).getByLabelText(`Answer to ${NOTES}`);

    field.focus();
    fireEvent.keyDown(field, { key: " ", code: "Space" });
    fireEvent.change(field, { target: { value: "too steep " } });
    fireEvent.keyUp(field, { key: " ", code: "Space" });

    expect(motionAround(field)).toEqual([]);
    expect(field.closest('[role="button"]')).toBeNull();
  });

  it("still gives a button a press, of at most 2% scale", async () => {
    await renderRound();

    const motion = pressMotion(screen.getByTestId("section-next"));

    expect(motion.length).toBeGreaterThan(0);
    const scales = motion.flatMap((name) => /scale-\[(\d*\.?\d+)\]/.exec(name)?.[1] ?? []).map(Number);
    expect(scales.every((scale) => scale >= 0.98)).toBe(true);
  });
});
