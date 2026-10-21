// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS as source } from "../server/round-fixtures.js";
import { getRound } from "../server/rounds.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";
import { checkAndSend, checkButton, shownSection, toSection } from "./pages/round-pager.test-helpers.js";

afterEach(cleanup);

const ROUND = "kiln-schedule-r2";

interface Rendered {
  calls: { name: string; args: unknown }[];
}

const SentArgs = z.object({ general: z.string(), answers: z.array(z.object({ questionId: z.string(), comment: z.string().optional() })) });
type SentArgs = z.infer<typeof SentArgs>;

/** The notes `rounds.get` reads back from the feedback.json a submit with these args writes. */
const notesOf = ({ general, answers }: SentArgs) => ({
  general,
  comments: Object.fromEntries(answers.flatMap(({ questionId, comment }) => (comment ? [[questionId, comment]] : []))),
});

/**
 * Renders the synthetic question round over a recorded snapshot. `rounds.submit` answers with `reply`; once it has
 * succeeded, `rounds.get` answers as the server would after a send: status sent, recommendations no longer withheld, the free text read back.
 */
async function renderRound(reply: ReturnType<typeof successEnvelope> | ReturnType<typeof errorEnvelope>): Promise<Rendered> {
  const unsent = await getRound(source, ROUND);
  if (!unsent.valid) throw new Error(unsent.reason);
  const recommendation = { answer: "Staged climb", rationale: "Staged climbs cracked fewer test tiles.", confidence: 0.7, by: "fixture-agent" };
  const revealed = { ...unsent.manifest, questions: unsent.manifest.questions.map((each) => (each.id === "ramp-default" ? { ...each, recommendation } : each)) };
  const snapshot: Snapshot = {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: { [snapshotKey("rounds.get", { id: ROUND })]: successEnvelope(unsent), [snapshotKey("rounds.list", {})]: successEnvelope({ rounds: [], truncated: false, dir: "/state/rounds" }) },
  };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  const inner = pageDataSource({ doc: page });
  const calls: Rendered["calls"] = [];
  let sent: SentArgs | null = null;
  const live: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => {
      calls.push({ name, args });
      if (name === "rounds.submit") {
        sent = reply.ok ? SentArgs.parse(args) : null;
        return Promise.resolve(reply);
      }
      if (name === "rounds.get" && sent) return Promise.resolve(successEnvelope({ ...unsent, status: "sent", recommendationsWithheld: false, manifest: revealed, notes: notesOf(sent) }));
      return inner.call(name, args, options);
    },
  };
  window.location.hash = `#/rounds/${ROUND}`;
  render(
    <RpcProvider source={live}>
      <AnswerSourceProvider value={live}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  await screen.findByTestId("round-question-ramp-default");
  return { calls };
}

const submitted = successEnvelope({ status: "submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: null });
const pick = (questionId: string, label: string): void => {
  const control = within(screen.getByTestId(`round-question-${questionId}`)).getByText(label).closest<HTMLElement>('[role="radio"], [role="checkbox"]');
  if (!control) throw new Error(`no control labelled ${label}`);
  fireEvent.click(control);
};
const comment = (prompt: string, text: string): void => {
  fireEvent.change(screen.getByLabelText(`Comment on ${prompt}`), { target: { value: text } });
};
const RAMP = "Which ramp should the calculator propose by default?";
const checkSend = (): HTMLElement => screen.getByTestId("round-check-send");
const submitCalls = ({ calls }: Rendered): unknown[] => calls.filter((call) => call.name === "rounds.submit").map((call) => call.args);

describe("a question round's send", () => {
  it("is no longer read-only: it offers Check and send", async () => {
    await renderRound(submitted);
    expect(screen.queryByText(/Read-only/)).toBeNull();
    await toSection("report");
    expect(checkButton()).toBeTruthy();
  });

  it("sends its answers with the round.json shown, then shows the sent state and the revealed recommendations", async () => {
    const rendered = await renderRound(submitted);
    expect(screen.queryByText(/^Recommended:/)).toBeNull();

    pick("ramp-default", "2 Single slope");
    await toSection("report");
    checkAndSend();

    await screen.findByText("Answers sent");
    await toSection("ramp");
    const round = await getRound(source, ROUND);
    if (!round.valid) throw new Error(round.reason);
    expect(submitCalls(rendered)).toEqual([{ id: ROUND, manifestSha256: round.manifestSha256, general: "", answers: [{ questionId: "ramp-default", pick: "Single slope" }] }]);
    expect(await screen.findByText(/^Recommended: Staged climb/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check and send" })).toBeNull();
  });

  it("sends a round with its required question unanswered as a partial send (owner decision 513)", async () => {
    const rendered = await renderRound(submitted);
    await toSection("report");
    pick("report-columns", "1 Segment");

    fireEvent.click(checkButton());
    expect(checkSend().textContent).toBe("Send partial: 3 unanswered");
    fireEvent.click(checkSend());

    await screen.findByText("Answers sent");
    expect(submitCalls(rendered)).toMatchObject([{ answers: [{ questionId: "report-columns", picks: ["Segment"] }] }]);
  });

  it("says Already answered when the server reports the round was already submitted", async () => {
    await renderRound(successEnvelope({ status: "already-submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: null }));
    pick("ramp-default", "1 Staged climb");
    await toSection("report");
    checkAndSend();

    expect(await screen.findByText("Already answered")).toBeTruthy();
    expect(screen.queryByText("Answers sent")).toBeNull();
  });

  it("shows the server's refusal and does not mark the round sent", async () => {
    await renderRound(errorEnvelope("Refused: this session cannot write; owner writes are off", 403));
    pick("ramp-default", "1 Staged climb");
    await toSection("report");
    checkAndSend();

    expect(await screen.findByText("Not sent: Refused: this session cannot write; owner writes are off")).toBeTruthy();
    expect(screen.queryByText("Answers sent")).toBeNull();
    expect(screen.queryByText(/^Recommended:/)).toBeNull();
    expect(checkSend().getAttribute("aria-disabled")).not.toBe("true");
  });
});

describe("a question round's free text", () => {
  it("sends a comment on every kind of question with that question's answer", async () => {
    const rendered = await renderRound(submitted);
    pick("ramp-default", "1 Staged climb");
    pick("hold-clarity", "4 4");
    comment(RAMP, "Staged, but keep single for bisque.");
    comment("How clearly does the top hold step read?", "The hold label is small.");
    await toSection("report");
    pick("report-columns", "1 Segment");
    fireEvent.change(screen.getByLabelText("Answer to Anything else the report should say?"), { target: { value: "Add cone numbers." } });
    comment("Which columns belong in the printed report?", "Rate matters least.");
    comment("Anything else the report should say?", "Low priority.");

    checkAndSend();

    await screen.findByText("Answers sent");
    expect(submitCalls(rendered)).toMatchObject([
      {
        answers: [
          { questionId: "ramp-default", pick: "Staged climb", comment: "Staged, but keep single for bisque." },
          { questionId: "hold-clarity", value: 4, comment: "The hold label is small." },
          { questionId: "report-columns", picks: ["Segment"], comment: "Rate matters least." },
          { questionId: "report-notes", text: "Add cone numbers.", comment: "Low priority." },
        ],
      },
    ]);
  });

  it("sends a comment on a question left unanswered, as a comment-only answer", async () => {
    const rendered = await renderRound(submitted);
    pick("ramp-default", "1 Staged climb");
    await toSection("report");
    comment("Which columns belong in the printed report?", "  Not sure yet: ask the studio.  ");

    checkAndSend();

    await screen.findByText("Answers sent");
    expect(submitCalls(rendered)).toMatchObject([
      { answers: [{ questionId: "ramp-default", pick: "Staged climb" }, { questionId: "report-columns", comment: "Not sure yet: ask the studio." }] },
    ]);
  });

  it("does not count a comment alone as an answer to a required question", async () => {
    await renderRound(submitted);
    comment(RAMP, "I need to see both ramps first.");
    await toSection("report");

    fireEvent.click(checkButton());
    const row = screen.getByTestId("round-check-answer-ramp-default");
    expect(row.getAttribute("data-unanswered")).toBe("true");
    expect(within(row).getByText("required, unanswered")).toBeTruthy();
    expect(within(row).getByText("I need to see both ramps first.")).toBeTruthy();
    expect(checkSend().textContent).toBe("Send partial: 4 unanswered");
  });

  it("sends the round's feedback as general", async () => {
    const rendered = await renderRound(submitted);
    pick("ramp-default", "1 Staged climb");
    await toSection("report");
    fireEvent.change(screen.getByLabelText("Feedback on this round"), { target: { value: " Good round, quick to answer. " } });

    checkAndSend();

    await screen.findByText("Answers sent");
    expect(submitCalls(rendered)).toMatchObject([{ general: "Good round, quick to answer." }]);
  });

  it("does not choose an option when a digit is typed into a comment box", async () => {
    await renderRound(submitted);
    const box = screen.getByLabelText(`Comment on ${RAMP}`);

    fireEvent.keyDown(box, { key: "2" });

    const control = within(screen.getByTestId("round-question-ramp-default")).getByText("2 Single slope").closest<HTMLElement>('[role="radio"]');
    expect(control?.getAttribute("aria-checked")).toBe("false");
  });

  it("shows the sent comments and round feedback read-only once the round is sent", async () => {
    await renderRound(submitted);
    pick("ramp-default", "1 Staged climb");
    await toSection("report");
    comment("Which columns belong in the printed report?", "Rate matters least.");
    fireEvent.change(screen.getByLabelText("Feedback on this round"), { target: { value: "Good round." } });

    checkAndSend();

    expect(await screen.findByTestId("round-comment-sent-report-columns")).toHaveProperty("textContent", "YOUR COMMENTRate matters least.");
    expect(screen.getByTestId("round-general-sent").textContent).toContain("Good round.");
    expect(screen.queryByLabelText("Feedback on this round")).toBeNull();
    await toSection("ramp");
    expect(screen.getByTestId("round-question-ramp-default")).toBeTruthy();
    expect(screen.queryByLabelText(`Comment on ${RAMP}`)).toBeNull();
  });
});

const checkScreen = (): HTMLElement | null => screen.queryByTestId("round-check");
const checkRow = (questionId: string): HTMLElement => screen.getByTestId(`round-check-answer-${questionId}`);
const press = (target: EventTarget, key: string, modifiers: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}): void => {
  fireEvent.keyDown(target, { key, ...modifiers });
};

/** Answers the ramp and its hold on the first page, then opens the check from the last one. */
async function answerRampAndCheck(): Promise<void> {
  pick("ramp-default", "2 Single slope");
  comment(RAMP, "Single for now.");
  await toSection("report");
  fireEvent.change(screen.getByLabelText("Feedback on this round"), { target: { value: "Quick round." } });
  fireEvent.click(checkButton());
}

describe("a round's check before sending (TP-3775)", () => {
  it("lists every answer by section, with its pick and comment, and marks the unanswered ones", async () => {
    await renderRound(submitted);
    await answerRampAndCheck();

    expect(screen.getByText("Check before sending")).toBeTruthy();
    expect(within(screen.getByTestId("round-check-section-ramp")).getByText("FIRING RAMP")).toBeTruthy();
    expect(within(checkRow("ramp-default")).getByText("Single slope")).toBeTruthy();
    expect(within(checkRow("ramp-default")).getByText("Single for now.")).toBeTruthy();
    expect(checkRow("ramp-default").getAttribute("data-unanswered")).toBeNull();
    for (const id of ["hold-clarity", "report-columns", "report-notes"]) expect(checkRow(id).getAttribute("data-unanswered")).toBe("true");
    expect(screen.getByText("Quick round.")).toBeTruthy();
    expect(screen.getByTestId("round-check-unanswered").textContent).toContain("3 of 4 questions are unanswered");
    expect(screen.queryByTestId("section-pager")).toBeNull();
  });

  it("filters to the unanswered questions", async () => {
    await renderRound(submitted);
    await answerRampAndCheck();

    fireEvent.click(screen.getByTestId("round-check-filter"));

    expect(screen.queryByTestId("round-check-answer-ramp-default")).toBeNull();
    expect(checkRow("hold-clarity")).toBeTruthy();
    expect(checkRow("report-notes")).toBeTruthy();
  });

  it("steps to the next unanswered question on its own page, where digit keys answer it", async () => {
    await renderRound(submitted);
    await answerRampAndCheck();

    fireEvent.click(screen.getByTestId("round-check-next-unanswered"));
    await waitFor(() => expect(shownSection()).toBe("ramp"));
    await act(async () => undefined);

    expect(checkScreen()).toBeNull();
    expect(window.location.hash).toContain("section=ramp");
    press(window, "4");
    await toSection("report");
    fireEvent.click(checkButton());
    expect(within(checkRow("hold-clarity")).getByText("4")).toBeTruthy();
    expect(checkSend().textContent).toBe("Send partial: 2 unanswered");
  });

  it("goes back to answering on Esc, with nothing sent and every answer kept", async () => {
    const rendered = await renderRound(submitted);
    await answerRampAndCheck();

    press(window, "Escape");

    expect(checkScreen()).toBeNull();
    expect(checkButton()).toBeTruthy();
    expect(submitCalls(rendered)).toEqual([]);
    fireEvent.click(checkButton());
    expect(within(checkRow("ramp-default")).getByText("Single slope")).toBeTruthy();
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("sends on Enter with %o", async (modifier) => {
    const rendered = await renderRound(submitted);
    await answerRampAndCheck();

    press(window, "Enter", modifier);

    await screen.findByText("Answers sent");
    expect(submitCalls(rendered)).toHaveLength(1);
    expect(checkScreen()).toBeNull();
  });

  it("ignores Enter without Cmd or Ctrl, Cmd+Enter with another modifier, and keys typed into a field", async () => {
    const rendered = await renderRound(submitted);
    await answerRampAndCheck();
    const field = document.body.appendChild(document.createElement("input"));

    press(window, "Enter");
    press(window, "Enter", { metaKey: true, shiftKey: true });
    press(window, "Enter", { ctrlKey: true, altKey: true });
    press(window, "Escape", { metaKey: true });
    press(field, "Enter", { metaKey: true });
    press(field, "Escape");

    expect(submitCalls(rendered)).toEqual([]);
    expect(checkScreen()).toBeTruthy();
    field.remove();
  });

  it("takes no page keys while it is open: digits change no answer and n and p turn no page", async () => {
    await renderRound(submitted);
    await answerRampAndCheck();

    press(window, "1");
    press(window, "p");

    expect(within(checkRow("ramp-default")).getByText("Single slope")).toBeTruthy();
    press(window, "Escape");
    expect(shownSection()).toBe("report");
  });

  it("reads Send answers, with no unanswered notice, once every question is answered", async () => {
    await renderRound(submitted);
    pick("ramp-default", "1 Staged climb");
    pick("hold-clarity", "3 3");
    await toSection("report");
    pick("report-columns", "1 Segment");
    fireEvent.change(screen.getByLabelText("Answer to Anything else the report should say?"), { target: { value: "Add cone numbers." } });

    fireEvent.click(checkButton());

    expect(checkSend().textContent).toBe("Send answers");
    expect(screen.queryByTestId("round-check-unanswered")).toBeNull();
    expect(screen.queryByTestId("round-check-filter")).toBeNull();
  });
});
