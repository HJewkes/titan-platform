// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS as source } from "../server/round-fixtures.js";
import { getRound } from "../server/rounds.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";

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
const sendButton = (): HTMLElement => screen.getByRole("button", { name: "Send answers" });
const pick = (questionId: string, label: string): void => {
  const control = within(screen.getByTestId(`round-question-${questionId}`)).getByText(label).closest<HTMLElement>('[role="radio"], [role="checkbox"]');
  if (!control) throw new Error(`no control labelled ${label}`);
  fireEvent.click(control);
};
const comment = (prompt: string, text: string): void => {
  fireEvent.change(screen.getByLabelText(`Comment on ${prompt}`), { target: { value: text } });
};
const RAMP = "Which ramp should the calculator propose by default?";
const submitCalls = ({ calls }: Rendered): unknown[] => calls.filter((call) => call.name === "rounds.submit").map((call) => call.args);

describe("a question round's send", () => {
  it("is no longer read-only: it offers Send answers", async () => {
    await renderRound(submitted);
    expect(screen.queryByText(/Read-only/)).toBeNull();
    expect(sendButton()).toBeTruthy();
  });

  it("sends its answers with the round.json shown, then shows the sent state and the revealed recommendations", async () => {
    const rendered = await renderRound(submitted);
    expect(screen.queryByText(/^Recommended:/)).toBeNull();

    pick("ramp-default", "2 Single slope");
    fireEvent.click(sendButton());

    await screen.findByText("Answers sent");
    const round = await getRound(source, ROUND);
    if (!round.valid) throw new Error(round.reason);
    expect(submitCalls(rendered)).toEqual([{ id: ROUND, manifestSha256: round.manifestSha256, general: "", answers: [{ questionId: "ramp-default", pick: "Single slope" }] }]);
    expect(await screen.findByText(/^Recommended: Staged climb/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
  });

  it("holds back a send until the required question has an answer, and sends the optional ones it has", async () => {
    const rendered = await renderRound(submitted);
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/Answer the required question first: Which ramp should the calculator propose by default\?/)).toBeTruthy();
    fireEvent.click(sendButton());
    expect(submitCalls(rendered)).toEqual([]);

    pick("report-columns", "1 Segment");
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
    pick("ramp-default", "1 Staged climb");
    fireEvent.click(sendButton());

    await screen.findByText("Answers sent");
    expect(submitCalls(rendered)).toMatchObject([
      { answers: [{ questionId: "ramp-default", pick: "Staged climb" }, { questionId: "report-columns", picks: ["Segment"] }] },
    ]);
  });

  it("says Already answered when the server reports the round was already submitted", async () => {
    await renderRound(successEnvelope({ status: "already-submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: null }));
    pick("ramp-default", "1 Staged climb");
    fireEvent.click(sendButton());

    expect(await screen.findByText("Already answered")).toBeTruthy();
    expect(screen.queryByText("Answers sent")).toBeNull();
  });

  it("shows the server's refusal and does not mark the round sent", async () => {
    await renderRound(errorEnvelope("Refused: this session cannot write; owner writes are off", 403));
    pick("ramp-default", "1 Staged climb");
    fireEvent.click(sendButton());

    expect(await screen.findByText("Not sent: Refused: this session cannot write; owner writes are off")).toBeTruthy();
    expect(screen.queryByText("Answers sent")).toBeNull();
    expect(screen.queryByText(/^Recommended:/)).toBeNull();
    expect(sendButton()).toBeTruthy();
  });
});

describe("a question round's free text", () => {
  it("sends a comment on every kind of question with that question's answer", async () => {
    const rendered = await renderRound(submitted);
    pick("ramp-default", "1 Staged climb");
    pick("hold-clarity", "4 4");
    pick("report-columns", "1 Segment");
    fireEvent.change(screen.getByLabelText("Answer to Anything else the report should say?"), { target: { value: "Add cone numbers." } });
    comment(RAMP, "Staged, but keep single for bisque.");
    comment("How clearly does the top hold step read?", "The hold label is small.");
    comment("Which columns belong in the printed report?", "Rate matters least.");
    comment("Anything else the report should say?", "Low priority.");

    fireEvent.click(sendButton());

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
    comment("Which columns belong in the printed report?", "  Not sure yet: ask the studio.  ");

    fireEvent.click(sendButton());

    await screen.findByText("Answers sent");
    expect(submitCalls(rendered)).toMatchObject([
      { answers: [{ questionId: "ramp-default", pick: "Staged climb" }, { questionId: "report-columns", comment: "Not sure yet: ask the studio." }] },
    ]);
  });

  it("does not count a comment alone as an answer to a required question", async () => {
    await renderRound(submitted);
    comment(RAMP, "I need to see both ramps first.");

    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("sends the round's feedback as general", async () => {
    const rendered = await renderRound(submitted);
    pick("ramp-default", "1 Staged climb");
    fireEvent.change(screen.getByLabelText("Feedback on this round"), { target: { value: " Good round, quick to answer. " } });

    fireEvent.click(sendButton());

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
    comment("Which columns belong in the printed report?", "Rate matters least.");
    fireEvent.change(screen.getByLabelText("Feedback on this round"), { target: { value: "Good round." } });

    fireEvent.click(sendButton());

    expect(await screen.findByTestId("round-comment-sent-report-columns")).toHaveProperty("textContent", "YOUR COMMENTRate matters least.");
    expect(screen.getByTestId("round-general-sent").textContent).toContain("Good round.");
    expect(screen.queryByLabelText("Feedback on this round")).toBeNull();
    expect(screen.queryByLabelText(`Comment on ${RAMP}`)).toBeNull();
  });
});
