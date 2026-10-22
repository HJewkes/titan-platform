// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { invokeCommand } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, type DataSource } from "@titan-design/rpc-client";
import type { ConsoleContext } from "../../server/owner-guard.js";
import { stagedRound, type StagedRound } from "../../server/round-fixtures.js";
import { FeedbackSchema } from "../../server/round-schema.js";
import { roundsSubmitCommands } from "../../server/rounds-submit.js";
import { getRound, type RoundDetail } from "../../server/rounds.js";
import { AnswerSourceProvider } from "../data/submit.js";
import { getButton } from "./get-button.test-helpers.js";
import { RoundSections, orderedQuestions, useRoundAnswers } from "./RoundSections.js";
import { RoundSend, useRoundSend } from "./RoundSend.js";

class IdleObserver {
  observe(): void {}
  disconnect(): void {}
}

const ROUND = "beacon-revision-r1";
const REVISE = "None of these, request a revision";

/** A synthetic round: a required pick-one, one with its own revision option, and an optional one. */
const roundJson = {
  schema: "titan-review/round@2",
  unit: "beacon-dot",
  round: 1,
  storybookUrl: "http://127.0.0.1:6006",
  widths: [390],
  variants: [{ key: "beacon-idle", image: "shots/beacon-idle.png", label: "Idle" }],
  sections: [{ id: "shape", title: "Shape", deciding: "The beacon's shape.", changed: "The beacon gained edges.", context: "Colours are out of scope.", kind: "STATES", variantKeys: ["beacon-idle"], questionIds: ["shape", "size", "edge"] }],
  questions: [
    { id: "shape", kind: "pick-one", prompt: "Which shape?", required: true, options: ["Round", "Square"], signsOff: "beacon-shape" },
    { id: "size", kind: "pick-one", prompt: "Which size?", required: true, options: ["Small", "Large", "Rethink the size"], revisionOption: "Rethink the size", signsOff: "beacon-size" },
    { id: "edge", kind: "pick-one", prompt: "Which edge?", options: ["Soft", "Hard"], signsOff: "beacon-edge" },
  ],
};

type ValidRound = Extract<RoundDetail, { valid: true }>;

let staged: StagedRound;
let round: ValidRound;

beforeEach(async () => {
  vi.stubGlobal("IntersectionObserver", IdleObserver);
  staged = await stagedRound("beacon-states-r1", ROUND, roundJson);
  const detail = await getRound(staged.source, ROUND);
  if (!detail.valid) throw new Error(detail.reason);
  round = detail;
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await staged.remove();
});

const OWNER: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: { credential: "session", issuedAt: 1_000, peerLocal: false }, ownerWrites: true };

const submitting = (reads: DataSource): DataSource => ({
  subscribe: reads.subscribe.bind(reads),
  call: async (_name, args) => (await invokeCommand(roundsSubmitCommands(staged.source)["rounds.submit"], args, OWNER)).envelope,
});

const emptyPage = (): Document => new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls: {} }), "text/html");

function Round(): ReactNode {
  const { submitting, check, locked, frozen } = useRoundSend(round);
  const state = useRoundAnswers(frozen ? [] : orderedQuestions(round.manifest).flatMap((group) => group.questions), round.notes, frozen);
  return (
    <>
      <RoundSections manifest={round.manifest} state={state} textAnswers locked={locked} />
      <RoundSend round={round} state={state} submitting={submitting} check={check} />
    </>
  );
}

function Page(): ReactNode {
  const reads = pageDataSource({ doc: emptyPage() });
  return (
    <RpcProvider source={reads}>
      <AnswerSourceProvider value={submitting(reads)}>
        <Round />
      </AnswerSourceProvider>
    </RpcProvider>
  );
}

const question = (id: string): HTMLElement => screen.getByTestId(`round-question-${id}`);
const pick = (id: string, label: string): void => void fireEvent.click(within(question(id)).getByText(label));
const commentOn = (prompt: string, text: string): void => void fireEvent.change(screen.getByLabelText(`Comment on ${prompt}`), { target: { value: text } });
const required = (id: string): HTMLElement | null => screen.queryByTestId(`round-comment-required-${id}`);
const openCheck = (): void => void fireEvent.click(getButton("Check and send"));
const sendDisabled = (): boolean => screen.getByTestId("round-check-send").getAttribute("aria-disabled") === "true";

describe("the built-in revision request", () => {
  it("is offered on a required pick-one with no revision option of its own, and nowhere else", () => {
    render(<Page />);

    expect(within(question("shape")).getByText(REVISE)).toBeTruthy();
    expect(within(question("size")).queryByText(REVISE)).toBeNull();
    expect(within(question("edge")).queryByText(REVISE)).toBeNull();
  });

  it("marks the comment required and holds the send while the comment is empty", () => {
    render(<Page />);

    pick("shape", REVISE);
    pick("size", "1 Small");

    expect(required("shape")).toBeTruthy();
    expect(screen.getByText("Comment (required)")).toBeTruthy();
    openCheck();
    expect(screen.getByTestId("round-check-answer-shape").getAttribute("data-unanswered")).toBe("true");
    expect(sendDisabled()).toBe(true);
  });

  it("clears the alert once the comment has text, and sends the request with it", async () => {
    render(<Page />);

    pick("shape", REVISE);
    pick("size", "1 Small");
    commentOn("Which shape?", "Try a hexagon.");

    expect(required("shape")).toBeNull();
    openCheck();
    expect(screen.getByTestId("round-check-answer-shape").hasAttribute("data-unanswered")).toBe(false);
    fireEvent.click(screen.getByTestId("round-check-send"));
    await screen.findByText("Answers sent");
    expect(FeedbackSchema.parse(await staged.feedback()).answers).toContainEqual(expect.objectContaining({ questionId: "shape", revisionRequested: true, comment: "Try a hexagon." }));
  });

  it("asks for a comment on a pick of the round's own revision option too", () => {
    render(<Page />);

    pick("shape", "1 Round");
    pick("size", "3 Rethink the size");

    expect(required("size")).toBeTruthy();
    openCheck();
    expect(screen.getByTestId("round-check-answer-size").getAttribute("data-unanswered")).toBe("true");
    expect(sendDisabled()).toBe(true);
  });
});
