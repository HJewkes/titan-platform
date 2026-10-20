// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS as source } from "../server/round-fixtures.js";
import { getRound, type RoundDetail } from "../server/rounds.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";

afterEach(cleanup);

const ROUND = "kiln-schedule-r2";
const RAMP = { answer: "Staged climb", rationale: "Staged climbs cracked fewer test tiles.", confidence: 0.7, by: "fixture-agent" };

interface Rendered {
  calls: { name: string; args: unknown }[];
}

/** The synthetic question round, unsent unless `detail` says otherwise; `rounds.reveal` hands back RAMP and `rounds.submit` succeeds. */
async function renderRound(detail: (unsent: Extract<RoundDetail, { valid: true }>) => Partial<RoundDetail> = () => ({})): Promise<Rendered> {
  const unsent = await getRound(source, ROUND);
  if (!unsent.valid) throw new Error(unsent.reason);
  const snapshot: Snapshot = {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: { [snapshotKey("rounds.get", { id: ROUND })]: successEnvelope({ ...unsent, ...detail(unsent) }), [snapshotKey("rounds.list", {})]: successEnvelope({ rounds: [], truncated: false, dir: "/state/rounds" }) },
  };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const calls: Rendered["calls"] = [];
  const live: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => {
      calls.push({ name, args });
      if (name === "rounds.reveal") return Promise.resolve(successEnvelope({ recommendation: RAMP, recorded: true }));
      if (name === "rounds.submit") return Promise.resolve(successEnvelope({ status: "submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: null }));
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

const ramp = () => within(screen.getByTestId("round-question-ramp-default"));
const pick = (label: string): void => {
  fireEvent.click(ramp().getByRole("radio", { name: new RegExp(label) }));
};
const callsNamed = ({ calls }: Rendered, name: string): unknown[] => calls.filter((call) => call.name === name).map((call) => call.args);
const SentAnswers = z.object({ answers: z.array(z.looseObject({ questionId: z.string() })) });
const rampAnswer = (rendered: Rendered) => SentAnswers.parse(callsNamed(rendered, "rounds.submit")[0]).answers.find((answer) => answer.questionId === "ramp-default");

describe("revealing a withheld recommendation", () => {
  it("reveals the active question's recommendation on r, through rounds.reveal, with a Recommended badge", async () => {
    const rendered = await renderRound();
    const detail = await getRound(source, ROUND);
    if (!detail.valid) throw new Error(detail.reason);
    const { manifestSha256 } = detail;
    expect(screen.queryByText(/^Recommended:/)).toBeNull();

    fireEvent.keyDown(window, { key: "r" });

    expect(await screen.findByText("Recommended: Staged climb (70%, fixture-agent)")).toBeTruthy();
    expect(callsNamed(rendered, "rounds.reveal")).toEqual([{ id: ROUND, manifestSha256, questionId: "ramp-default" }]);
    expect(ramp().getByText("Recommended")).toBeTruthy();
  });

  it("tags an answer given after the reveal seen, says it differs, and sends recommendationSeen", async () => {
    const rendered = await renderRound();
    fireEvent.keyDown(window, { key: "r" });
    await screen.findByTestId("recommendation-ramp-default");

    pick("Single slope");

    expect(await screen.findByText("Differs from your pick · seen before answering")).toBeTruthy();
    expect(screen.getByText("You revealed it before answering.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(callsNamed(rendered, "rounds.submit")).toHaveLength(1));
    expect(rampAnswer(rendered)).toEqual({ questionId: "ramp-default", pick: "Single slope", recommendationSeen: true });
  });

  it("shows the recommendation after a blind answer with a matches verdict, and sends the answer untagged", async () => {
    const rendered = await renderRound();

    pick("Staged climb");

    expect(await screen.findByText("Matches your pick")).toBeTruthy();
    expect(screen.getByText("Shown because you answered.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(callsNamed(rendered, "rounds.submit")).toHaveLength(1));
    expect(rampAnswer(rendered)).toEqual({ questionId: "ramp-default", pick: "Staged climb" });
  });

  it("ignores r with a modifier or while typing in a field", async () => {
    const rendered = await renderRound();

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText("Answer to Anything else the report should say?"), { key: "r" });

    expect(callsNamed(rendered, "rounds.reveal")).toEqual([]);
  });

  it("hides a revealed recommendation again while the question is unanswered", async () => {
    await renderRound();
    fireEvent.click(screen.getByTestId("reveal-ramp-default"));
    await screen.findByTestId("recommendation-ramp-default");

    fireEvent.click(screen.getByRole("button", { name: "Hide recommendation" }));

    expect(screen.queryByTestId("recommendation-ramp-default")).toBeNull();
  });
});

describe("a recommendation the server sends", () => {
  it("shows an open shown round's recommendation from the start, and its verdict once answered", async () => {
    await renderRound((unsent) => ({
      recommendationsWithheld: false,
      revealable: [],
      manifest: { ...unsent.manifest, recommendations: "shown", questions: unsent.manifest.questions.map((each) => (each.id === "ramp-default" ? { ...each, recommendation: RAMP } : each)) },
    }));
    expect(ramp().getByText("Recommended: Staged climb (70%, fixture-agent)")).toBeTruthy();
    expect(ramp().getByText("Recommended")).toBeTruthy();

    pick("Staged climb");

    expect(await ramp().findByText("Matches your pick · seen before answering")).toBeTruthy();
    expect(screen.queryByTestId("reveal-ramp-default")).toBeNull();
  });

  it("shows a sent round's verdict, weak point and fallback from the start, and offers no reveal", async () => {
    const recommendation = { ...RAMP, weakPoint: "Only **three** sample firings.", fallback: "Ask each time" };
    const rendered = await renderRound((unsent) => ({
      status: "sent",
      recommendationsWithheld: false,
      revealable: [],
      manifest: { ...unsent.manifest, questions: unsent.manifest.questions.map((each) => (each.id === "ramp-default" ? { ...each, recommendation } : each)) },
      notes: { general: "", comments: {}, answers: { "ramp-default": { pick: "Single slope", recommendationSeen: true } }, addressed: [] },
    }));

    expect(ramp().getByText("Differs from your pick · seen before answering")).toBeTruthy();
    expect(ramp().getByText("Weak point")).toBeTruthy();
    expect(ramp().getByText("three")).toBeTruthy();
    expect(ramp().getByText(/^Fallback:/).textContent).toBe("Fallback: Ask each time");
    expect(screen.queryByTestId("reveal-ramp-default")).toBeNull();
    expect(callsNamed(rendered, "rounds.reveal")).toEqual([]);
  });
});
