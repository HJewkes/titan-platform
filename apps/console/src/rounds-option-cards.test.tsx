// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { errorEnvelope, invokeCommand, successEnvelope } from "@titan-design/registry";
import type { DataSource } from "@titan-design/rpc-client";
import type { ConsoleContext } from "../server/owner-guard.js";
import { FIXTURE_ROUNDS, stagedRound, type StagedRound } from "../server/round-fixtures.js";
import { roundsSubmitCommands } from "../server/rounds-submit.js";
import { getRound } from "../server/rounds.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";
import { checkAndSend, checkButton, toSection } from "./pages/round-pager.test-helpers.js";

const ROUND = "kiln-packet-r2";
const OWNER: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: { credential: "session", issuedAt: 1_000, peerLocal: false }, ownerWrites: true };
const RAMP_DETAILS = {
  "Staged climb": { detail: "Three holds on the way up.", weakPoint: "Adds forty minutes to a firing.", after: "Make the staged climb the default ramp." },
  "Single slope": { detail: "One slope to peak." },
};

const Written = z.object({ answers: z.array(z.object({ questionId: z.string(), pick: z.string().optional(), optionNotes: z.unknown().optional() })) });

let staged: StagedRound;

/** kiln-schedule-r2 with a decision packet on its ramp question, in a temp rounds dir the real `rounds.submit` writes to. */
beforeEach(async () => {
  const fixture = await getRound(FIXTURE_ROUNDS, "kiln-schedule-r2");
  if (!fixture.valid) throw new Error(fixture.reason);
  const questions = fixture.manifest.questions.map((question) => (question.id === "ramp-default" ? { ...question, optionDetails: RAMP_DETAILS } : question));
  staged = await stagedRound("kiln-schedule-r2", ROUND, { ...fixture.manifest, questions });
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await staged.remove();
});

/** The round page over the staged dir: `rounds.get` reads it and `rounds.submit` writes its feedback.json. */
async function renderRound(): Promise<void> {
  const call: DataSource["call"] = async (name, args) => {
    if (name === "rounds.get") return successEnvelope(await getRound(staged.source, ROUND));
    if (name === "rounds.list") return successEnvelope({ rounds: [], truncated: false, dir: "/state/rounds" });
    if (name === "rounds.submit") return (await invokeCommand(roundsSubmitCommands(staged.source)["rounds.submit"], args, OWNER)).envelope;
    return errorEnvelope(`not stubbed: ${name}`, 1);
  };
  const live: DataSource = { call, subscribe: () => ({ close: () => undefined }) };
  window.location.hash = `#/rounds/${ROUND}`;
  render(
    <RpcProvider source={live}>
      <AnswerSourceProvider value={live}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  await screen.findByTestId("option-card-Staged climb");
}

const radioIn = (option: string): HTMLElement => {
  const found = screen.getByTestId(`option-card-${option}`).querySelector<HTMLElement>('[role="radio"]');
  if (!found) throw new Error(`no radio in the ${option} card`);
  return found;
};

/** Picks Single slope on its card and notes both packet options, as the owner would. */
function answerOnCards(): void {
  fireEvent.click(radioIn("Single slope"));
  fireEvent.change(screen.getByLabelText("Note on Staged climb"), { target: { value: "Too slow for test tiles." } });
  fireEvent.change(screen.getByLabelText("Note on Single slope"), { target: { value: "Fine for small loads." } });
}

describe("a round with option cards (G16)", () => {
  it("shows each card's option note on the check-before-send screen", async () => {
    await renderRound();
    answerOnCards();
    await toSection("report");
    fireEvent.click(checkButton());

    const row = screen.getByTestId("round-check-answer-ramp-default");
    expect(within(row).getByText("Single slope")).toBeTruthy();
    expect(within(row).getByText("Note on Staged climb")).toBeTruthy();
    expect(within(row).getByText("Too slow for test tiles.")).toBeTruthy();
    expect(within(row).getByText("Fine for small loads.")).toBeTruthy();
  });

  it("sends the card's pick with a note per option, and reads both back once sent", async () => {
    await renderRound();
    answerOnCards();
    await toSection("report");
    checkAndSend();
    await screen.findByText("Answers sent");

    const feedback = Written.parse(await staged.feedback());
    const ramp = feedback.answers.find((answer) => answer.questionId === "ramp-default");
    expect(ramp?.pick).toBe("Single slope");
    expect(ramp?.optionNotes).toEqual([
      { option: "Staged climb", note: "Too slow for test tiles." },
      { option: "Single slope", note: "Fine for small loads." },
    ]);

    await toSection("ramp");
    expect((await screen.findByTestId("option-note-sent-Staged climb")).textContent).toContain("Too slow for test tiles.");
    expect(screen.getByTestId("option-note-sent-Single slope").textContent).toContain("Fine for small loads.");
    expect(screen.queryByLabelText("Note on Staged climb")).toBeNull();
    expect(radioIn("Single slope").getAttribute("aria-checked")).toBe("true");
  });
});
