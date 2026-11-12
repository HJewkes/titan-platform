// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { invokeCommand, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, type DataSource } from "@titan-design/rpc-client";
import type { ConsoleContext } from "../server/owner-guard.js";
import { FEEDBACK_ROUND_ID, stagedFeedbackRound } from "../server/round-feedback.test-helpers.js";
import { roundsSubmitCommands } from "../server/rounds-submit.js";
import { getRound, type RoundsSource } from "../server/rounds.js";
import { renderPage } from "./render-page.test-helpers.js";

const OWNER: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: { credential: "session", issuedAt: 1_000, peerLocal: false }, ownerWrites: true };
const NOTES_41 = "Answer to Notes or ideas for a later iteration of example-org/example-design#41 (optional)";

let source: RoundsSource;
let remove: () => Promise<void>;
let submitted: unknown[];

beforeEach(async () => {
  ({ source, remove } = await stagedFeedbackRound());
  submitted = [];
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await remove();
});

/** The page over the staged sheet, with `rounds.get` and `rounds.submit` answered by the real commands. */
function liveSource(): DataSource {
  const empty = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls: {} }), "text/html");
  const inner = pageDataSource({ doc: empty });
  return {
    subscribe: inner.subscribe.bind(inner),
    call: async (name, args, options) => {
      if (name === "rounds.get") return successEnvelope(await getRound(source, FEEDBACK_ROUND_ID));
      if (name !== "rounds.submit") return inner.call(name, args, options);
      submitted.push(args);
      return (await invokeCommand(roundsSubmitCommands(source)["rounds.submit"], args, OWNER)).envelope;
    },
  };
}

async function renderSheet(): Promise<void> {
  const live = liveSource();
  renderPage(live, { view: "rounds", id: FEEDBACK_ROUND_ID }, { answers: live });
  await screen.findByTestId("round-feedback-sheet");
}

describe("a post-merge feedback sheet on #/rounds (TP-5458)", () => {
  it("shows each merged PR with its link, changed paths, context and one notes box", async () => {
    await renderSheet();

    expect(screen.getByTestId("round-feedback-link-example-org/example-design#41").textContent).toContain("example-org/example-design#41");
    expect(screen.getByTestId("round-feedback-files-example-org/example-design#44").textContent).toContain("src/tokens/color.json");
    expect(screen.getByText("task EX-101")).toBeTruthy();
    expect(screen.getByText(/Measured visual tier T2/)).toBeTruthy();
    expect(screen.getByLabelText(NOTES_41)).toBeTruthy();
  });

  it("offers no Ship, check screen or pending status", async () => {
    await renderSheet();

    expect(screen.queryByText("Ship")).toBeNull();
    expect(screen.queryByText("Check and send")).toBeNull();
    expect(screen.queryByText("open")).toBeNull();
  });

  it("answers the sheet when sent with every box blank", async () => {
    await renderSheet();

    fireEvent.click(screen.getByText("Mark read"));

    await screen.findByText("Feedback sent");
    expect(submitted).toEqual([expect.objectContaining({ answers: [] })]);
    expect((await getRound(source, FEEDBACK_ROUND_ID)).status).toBe("sent");
  });

  it("sends a typed note against its PR's question", async () => {
    await renderSheet();

    fireEvent.change(screen.getByLabelText(NOTES_41), { target: { value: "Tighten the focus ring." } });
    fireEvent.click(screen.getByText("Send notes"));

    await screen.findByText("Feedback sent");
    expect(submitted).toEqual([expect.objectContaining({ answers: [{ questionId: "notes-pr-41", text: "Tighten the focus ring." }] })]);
  });
});
