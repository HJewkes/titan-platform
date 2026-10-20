// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { invokeCommand, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey } from "@titan-design/rpc-client";
import type { ConsoleContext } from "../server/owner-guard.js";
import { FIXTURE_ROUNDS, stagedRound, type StagedRound } from "../server/round-fixtures.js";
import { roundsSubmitCommands } from "../server/rounds-submit.js";
import { getRound } from "../server/rounds.js";
import { App } from "./App.js";

const ROUND = "kiln-sent-r2";
const OWNER: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: { credential: "session", issuedAt: 1_000, peerLocal: false }, ownerWrites: true };

let staged: StagedRound;

/** kiln-schedule-r2, sent through the real `rounds.submit` with one answer of every kind the page takes. */
beforeEach(async () => {
  const fixture = await getRound(FIXTURE_ROUNDS, "kiln-schedule-r2");
  if (!fixture.valid) throw new Error(fixture.reason);
  staged = await stagedRound("kiln-schedule-r2", ROUND, fixture.manifest);
  const shown = await getRound(staged.source, ROUND);
  if (!shown.valid) throw new Error(shown.reason);
  const answers = [
    { questionId: "ramp-default", pick: "Single slope", comment: "The kiln is small." },
    { questionId: "hold-clarity", value: 3 },
    { questionId: "report-columns", picks: ["Segment", "Hold minutes"] },
    { questionId: "report-notes", text: "Print the cone." },
  ];
  const { envelope } = await invokeCommand(roundsSubmitCommands(staged.source)["rounds.submit"], { id: ROUND, manifestSha256: shown.manifestSha256, general: "Good pass.", answers }, OWNER);
  if (!envelope.ok) throw new Error(envelope.error);
});

afterEach(async () => {
  cleanup();
  await staged.remove();
});

/** The page as a reload draws it: everything it knows comes from rounds.get over the round dir. */
async function reload(): Promise<void> {
  const calls = { [snapshotKey("rounds.get", { id: ROUND })]: successEnvelope(await getRound(staged.source, ROUND)) };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls }), "text/html");
  window.location.hash = `#/rounds/${ROUND}`;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
  await screen.findByTestId("round-question-ramp-default");
}

const control = (questionId: string, label: string): HTMLElement => {
  const found = within(screen.getByTestId(`round-question-${questionId}`)).getByText(label).closest<HTMLElement>('[role="radio"], [role="checkbox"]');
  if (!found) throw new Error(`no control labelled ${label}`);
  return found;
};
const checked = (questionId: string, label: string): boolean => control(questionId, label).getAttribute("aria-checked") === "true";

describe("a sent question round read back after a reload (TP-3767)", () => {
  it("marks every question's sent answer: pick, scale, pick-many and text", async () => {
    await reload();

    expect(checked("ramp-default", "2 Single slope")).toBe(true);
    expect(checked("hold-clarity", "3 3")).toBe(true);
    expect(checked("report-columns", "1 Segment")).toBe(true);
    expect(checked("report-columns", "4 Hold minutes")).toBe(true);
    expect(checked("report-columns", "2 Target temperature")).toBe(false);
    expect(screen.getByLabelText<HTMLTextAreaElement>("Answer to Anything else the report should say?").value).toBe("Print the cone.");
    expect(screen.getByTestId("round-comment-sent-ramp-default").textContent).toContain("The kiln is small.");
    expect(screen.getByTestId("round-general-sent").textContent).toContain("Good pass.");
  });

  it("locks every question: inert, and no digit key or press changes a sent answer", async () => {
    await reload();

    for (const id of ["ramp-default", "hold-clarity", "report-columns", "report-notes"]) expect(screen.getByTestId(`round-entry-${id}`).hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(window, { key: "1" });
    fireEvent.click(control("ramp-default", "3 Ask each time"));
    fireEvent.change(screen.getByLabelText("Answer to Anything else the report should say?"), { target: { value: "Changed." } });

    expect(checked("ramp-default", "2 Single slope")).toBe(true);
    expect(checked("ramp-default", "1 Staged climb")).toBe(false);
    expect(checked("ramp-default", "3 Ask each time")).toBe(false);
    expect(screen.getByLabelText<HTMLTextAreaElement>("Answer to Anything else the report should say?").value).toBe("Print the cone.");
    expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
  });
});
