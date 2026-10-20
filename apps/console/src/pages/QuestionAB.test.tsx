// @vitest-environment jsdom
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { invokeCommand } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, type DataSource } from "@titan-design/rpc-client";
import type { ConsoleContext } from "../../server/owner-guard.js";
import { FIXTURE_ROUNDS } from "../../server/round-fixtures.js";
import { FeedbackSchema, RoundSchema } from "../../server/round-schema.js";
import { roundsSubmitCommands } from "../../server/rounds-submit.js";
import { getRound, type RoundDetail } from "../../server/rounds.js";
import { AnswerSourceProvider } from "../data/submit.js";
import { RoundFramesProvider, anchoredKeys } from "./QuestionFrames.js";
import { RoundSections, orderedQuestions, useRoundAnswers } from "./RoundSections.js";
import { RoundSend } from "./RoundSend.js";

/** Frames stay unfetched: this observer never reports an intersection. */
class IdleObserver {
  observe(): void {}
  disconnect(): void {}
}

const ROUND = "beacon-ab-r1";
const notes = { changed: "The beacon gained a pulse.", context: "Colours are out of scope." };

/** A synthetic round over the beacon fixture's frames: two A/B questions and one plain pick-one. */
const roundJson = {
  schema: "titan-review/round@2",
  unit: "beacon-dot",
  round: 1,
  storybookUrl: "http://127.0.0.1:6006",
  widths: [390],
  variants: [
    { key: "beacon-idle", image: "shots/beacon-idle.png", label: "Idle" },
    { key: "beacon-busy", image: "shots/beacon-busy.png", label: "Busy" },
    { key: "beacon-error", image: "shots/beacon-error.png", label: "Error" },
    { key: "beacon-muted", image: "shots/beacon-muted.png", label: "Muted" },
    { key: "beacon-sketch", storyId: "beacon-dot--sketch", label: "Pencil sketch" },
  ],
  sections: [
    { id: "pulse", title: "Pulse", deciding: "Whether the beacon pulses.", ...notes, kind: "CHOICE", variantKeys: ["beacon-idle", "beacon-busy"], questionIds: ["pulse-ab"] },
    { id: "tone", title: "Tone", deciding: "Which alert tone reads.", ...notes, kind: "CHOICE", variantKeys: ["beacon-error", "beacon-muted"], questionIds: ["tone-ab"] },
    { id: "fill", title: "Fill", deciding: "Ring or filled.", ...notes, kind: "STATES", variantKeys: ["beacon-sketch"], questionIds: ["fill-pick"] },
  ],
  questions: [
    {
      id: "pulse-ab",
      kind: "pick-one",
      prompt: "Which beacon reads better?",
      required: true,
      options: ["Calm", "Pulsing", "Both"],
      optionVariants: { Calm: "beacon-idle", Pulsing: "beacon-busy" },
      signsOff: "beacon-pulse",
    },
    { id: "tone-ab", kind: "pick-one", prompt: "Which alert tone?", options: ["beacon-error", "beacon-muted"], signsOff: "beacon-tone" },
    { id: "fill-pick", kind: "pick-one", prompt: "Filled or a ring?", options: ["Filled", "Ring"], signsOff: "beacon-fill" },
  ],
};

type ValidRound = Extract<RoundDetail, { valid: true }>;

let root: string;
let round: ValidRound;

/** The beacon fixture's frames and shots, under a round.json of our own, so `rounds.submit` really writes. */
beforeEach(async () => {
  vi.stubGlobal("IntersectionObserver", IdleObserver);
  root = await mkdtemp(path.join(tmpdir(), "question-ab-"));
  await cp(path.join(FIXTURE_ROUNDS.dir, "beacon-states-r1"), path.join(root, ROUND), { recursive: true });
  await writeFile(path.join(root, ROUND, "round.json"), JSON.stringify(roundJson));
  const detail = await getRound({ dir: root }, ROUND);
  if (!detail.valid) throw new Error(detail.reason);
  round = detail;
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

const OWNER: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: { credential: "session", issuedAt: 1_000, peerLocal: false }, ownerWrites: true };

/** Answers go to the real `rounds.submit` over the temp rounds dir; reads come from an empty snapshot. */
const submitting = (reads: DataSource): DataSource => ({
  subscribe: reads.subscribe.bind(reads),
  call: async (_name, args) => (await invokeCommand(roundsSubmitCommands({ dir: root })["rounds.submit"], args, OWNER)).envelope,
});

const emptyPage = (): Document => new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls: {} }), "text/html");

function Round({ framed }: { framed: boolean }): ReactNode {
  const state = useRoundAnswers(orderedQuestions(round.manifest).flatMap((group) => group.questions));
  const sections = <RoundSections manifest={round.manifest} state={state} textAnswers />;
  return (
    <>
      {framed ? <RoundFramesProvider roundId={ROUND} manifest={round.manifest}>{sections}</RoundFramesProvider> : sections}
      <RoundSend round={round} state={state} />
    </>
  );
}

function Page({ framed = true }: { framed?: boolean }): ReactNode {
  const reads = pageDataSource({ doc: emptyPage() });
  return (
    <RpcProvider source={reads}>
      <AnswerSourceProvider value={submitting(reads)}>
        <Round framed={framed} />
      </AnswerSourceProvider>
    </RpcProvider>
  );
}

const side = (questionId: string, name: "A" | "B"): HTMLElement => screen.getByTestId(`question-ab-side-${questionId}-${name}`);
const pressed = (button: HTMLElement): string | null => button.closest("[aria-pressed]")?.getAttribute("aria-pressed") ?? null;
const sendButton = (): HTMLElement => screen.getByRole("button", { name: "Send answers" });

async function sentFeedback(): Promise<unknown> {
  fireEvent.click(sendButton());
  await screen.findByText("Answers sent");
  return FeedbackSchema.parse(JSON.parse(await readFile(path.join(root, ROUND, "feedback.json"), "utf8")));
}

describe("an A/B question", () => {
  it("lays its two options side by side, each with its own frame, pick and note", () => {
    render(<Page />);

    expect(screen.getByTestId("question-ab-pulse-ab").className).toContain("sm:grid-cols-2");
    for (const [name, option, frame] of [["A", "Calm", "Idle"], ["B", "Pulsing", "Busy"]] as const) {
      const column = side("pulse-ab", name);
      expect(within(column).getByText(`${name}: ${option}`)).toBeTruthy();
      expect(within(column).getByText(`frame: ${frame}`)).toBeTruthy();
      expect(within(column).getByText("Loads when scrolled into view")).toBeTruthy();
      expect(within(column).getByLabelText(`Note on ${option}`)).toBeTruthy();
    }
    expect(screen.queryByText("1 Calm (frame: Idle)")).toBeNull();
  });

  it("treats options that name frames directly as sides too", () => {
    render(<Page />);
    expect(within(side("tone-ab", "A")).getByText("frame: Error")).toBeTruthy();
    expect(within(side("tone-ab", "B")).getByText("frame: Muted")).toBeTruthy();
  });

  it("keeps a section strip from drawing the frames its A/B already shows", () => {
    expect([...anchoredKeys(round.manifest)].sort()).toEqual(["beacon-busy", "beacon-error", "beacon-idle", "beacon-muted"]);
  });

  it("records the side picked, by its button or its digit key", async () => {
    render(<Page />);

    fireEvent.click(within(side("pulse-ab", "A")).getByText("1 Pick A"));
    expect(pressed(within(side("pulse-ab", "A")).getByText("Picked A"))).toBe("true");
    fireEvent.keyDown(window, { key: "2" });
    expect(within(side("pulse-ab", "B")).getByText("Picked B")).toBeTruthy();

    expect(await sentFeedback()).toMatchObject({ answers: [{ questionId: "pulse-ab", pick: "Pulsing" }] });
  });

  it("sends a note per side in optionNotes, and typing a digit in a note picks nothing", async () => {
    render(<Page />);

    const note = within(side("pulse-ab", "B")).getByLabelText("Note on Pulsing");
    fireEvent.keyDown(note, { key: "1" });
    fireEvent.change(note, { target: { value: "Too busy at 1 Hz." } });
    expect(within(side("pulse-ab", "A")).queryByText("Picked A")).toBeNull();
    fireEvent.click(within(side("pulse-ab", "A")).getByText("1 Pick A"));
    fireEvent.change(within(side("pulse-ab", "A")).getByLabelText("Note on Calm"), { target: { value: " Reads at a glance. " } });

    expect(await sentFeedback()).toMatchObject({
      answers: [{ questionId: "pulse-ab", pick: "Calm", optionNotes: [{ option: "Calm", note: "Reads at a glance." }, { option: "Pulsing", note: "Too busy at 1 Hz." }] }],
    });
  });

  it("offers the round's further option, such as Both, as a pick", async () => {
    render(<Page />);

    fireEvent.click(screen.getByText("3 Both"));

    expect(await sentFeedback()).toMatchObject({ answers: [{ questionId: "pulse-ab", pick: "Both" }] });
  });

  it("sends Neither as a revision request, once the comment says what to change", async () => {
    render(<Page />);

    fireEvent.click(screen.getByText("Neither: request a revision"));
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(screen.getByLabelText("Comment on Which beacon reads better?"), { target: { value: "Try a slow fade." } });

    expect(await sentFeedback()).toMatchObject({ answers: [{ questionId: "pulse-ab", revisionRequested: true, comment: "Try a slow fade." }] });
  });

  it("offers no Neither where the question offers no revision request", () => {
    render(<Page />);
    expect(within(screen.getByTestId("round-question-tone-ab")).queryByText(/^Neither/)).toBeNull();
  });
});

describe("a question that is not an A/B", () => {
  it("keeps today's radio layout", () => {
    render(<Page />);
    const card = screen.getByTestId("round-question-fill-pick");
    expect(within(card).queryByTestId("question-ab-fill-pick")).toBeNull();
    expect(within(card).getByText("1 Filled")).toBeTruthy();
  });

  it("outside a round's provider, an A/B question draws as a plain pick-one", () => {
    render(<Page framed={false} />);
    expect(screen.queryByTestId("question-ab-pulse-ab")).toBeNull();
    expect(screen.getByText("1 Calm")).toBeTruthy();
  });

  it("parses the synthetic round with the strict schema", () => {
    expect(RoundSchema.safeParse(roundJson).success).toBe(true);
  });
});
