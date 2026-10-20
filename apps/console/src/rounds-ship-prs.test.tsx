// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { PANELS_HEAD, TILES_HEAD, stagedRound, twoPrRound, type StagedRound } from "../server/round-fixtures.js";
import { getFrame } from "../server/round-frames.js";
import { getRound, type RoundDetail } from "../server/rounds.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";

const ROUND = "tiles-and-panels-r1";
const FRAMES = [
  { key: "tile-light", theme: "light", views: ["head", "base", "diff"] },
  { key: "tile-dark", theme: "dark", views: ["head", "base", "diff"] },
  { key: "panel-wide", theme: "light", views: ["head", "base"] },
  { key: "badge-new", views: ["head"] },
] as const;

class SilentObserver {
  observe(): void {}
  disconnect(): void {}
}

let staged: StagedRound;
beforeAll(async () => {
  staged = await stagedRound("ship-tile-r1", ROUND, twoPrRound());
});
afterAll(() => staged.remove());
beforeEach(() => vi.stubGlobal("IntersectionObserver", SilentObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function recorded(detail: Partial<RoundDetail>): Promise<Snapshot> {
  const frames = await Promise.all(
    FRAMES.flatMap(({ key, views }) => views.map(async (view) => [snapshotKey("rounds.frame", { id: ROUND, key, view }), successEnvelope(await getFrame(staged.source, ROUND, key, view))] as const)),
  );
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: {
      [snapshotKey("rounds.get", { id: ROUND })]: successEnvelope({ ...(await getRound(staged.source, ROUND)), ...detail }),
      [snapshotKey("rounds.frames", { id: ROUND })]: successEnvelope({ frames: FRAMES }),
      ...Object.fromEntries(frames),
    },
  };
}

/** The two-PR round over a recorded snapshot; rounds.submit answers "submitted" and every call is kept. */
async function renderPrs(detail: Partial<RoundDetail> = {}): Promise<{ name: string; args: unknown }[]> {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", await recorded(detail)), "text/html");
  const inner = pageDataSource({ doc: page });
  const calls: { name: string; args: unknown }[] = [];
  const submitted = successEnvelope({ status: "submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: null });
  const counting: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (calls.push({ name, args }), name === "rounds.submit" ? Promise.resolve(submitted) : inner.call(name, args, options)),
  };
  window.location.hash = `#/rounds/${ROUND}`;
  render(
    <RpcProvider source={counting}>
      <AnswerSourceProvider value={counting}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  await screen.findAllByTestId("montage-tile-light");
  return calls;
}

/** The two-PR round with its tiles side question required. */
async function withRequiredSide(): Promise<Partial<RoundDetail>> {
  const detail = await getRound(staged.source, ROUND);
  if (!detail.valid) throw new Error("the two-PR fixture round is invalid");
  const questions = detail.manifest.questions.map((question) => (question.id === "stripe-colour" ? { ...question, required: true } : question));
  return { manifest: { ...detail.manifest, questions } };
}

const pr = (key: string) => within(screen.getByTestId(`pr-${key}`));
const button = (label: string): HTMLElement => screen.getByRole("button", { name: label });
const disabled = (label: string): boolean => button(label).getAttribute("aria-disabled") === "true";
const submits = (calls: { name: string; args: unknown }[]) => calls.filter((call) => call.name === "rounds.submit").map((call) => call.args);

describe("a Ship round with two PRs (TP-3329)", () => {
  it("shows each PR's proposal, changes and only its own frames", async () => {
    await renderPrs();

    expect(pr("example/tiles#1").getByTestId("proposal-example/tiles#1").textContent).toContain("Moves the stripe up six pixels");
    expect(pr("example/tiles#1").getByText("Changed: The tile stripe moved up six pixels.")).toBeTruthy();
    expect(pr("example/tiles#1").getByTestId("montage-tile-dark")).toBeTruthy();
    expect(pr("example/tiles#1").queryByTestId("montage-panel-wide")).toBeNull();
    expect(pr("example/panels#2").getByTestId("montage-panel-wide")).toBeTruthy();
    expect(pr("example/panels#2").getByText("What ships: example/panels#2 at fedcba9, 2 changed frames")).toBeTruthy();
    expect(pr("example/tiles#1").getByText("Keep the stripe colour?")).toBeTruthy();
  });

  it("sends nothing until every PR has Ship or Send back", async () => {
    await renderPrs();

    fireEvent.click(button("Ship example/tiles#1"));

    expect(disabled("Send answers")).toBe(true);
    expect(screen.getByTestId("prs-send-problems").textContent).toContain("choose Ship or Send back for example/panels#2");
  });

  it("ships one PR at its own head and sends the other back with its note, in one submit", async () => {
    const calls = await renderPrs();

    fireEvent.click(button("Ship example/tiles#1"));
    fireEvent.change(screen.getByLabelText("Note for Send back on example/panels#2"), { target: { value: " Narrow it again. " } });
    fireEvent.click(button("Send back example/panels#2"));
    fireEvent.click(button("Send answers"));

    expect(submits(calls)).toEqual([
      expect.objectContaining({
        answers: [{ questionId: "ship-tiles", pick: "Ship" }, { questionId: "ship-panels", pick: "Don't ship", comment: "Narrow it again." }],
        heads: { "ship-tiles": TILES_HEAD },
      }),
    ]);
  });

  it("keeps a PR's Ship open while its own Send back note is typed", async () => {
    await renderPrs();

    fireEvent.change(screen.getByLabelText("Note for Send back on example/panels#2"), { target: { value: "Narrow it again." } });
    fireEvent.click(button("Send back example/panels#2"));

    expect(disabled("Ship example/panels#2")).toBe(false);
  });

  it("ships both PRs, each at its own head", async () => {
    const calls = await renderPrs();

    fireEvent.click(button("Ship example/tiles#1"));
    fireEvent.click(button("Ship example/panels#2"));
    fireEvent.click(button("Send answers"));

    expect(submits(calls)).toEqual([expect.objectContaining({ heads: { "ship-tiles": TILES_HEAD, "ship-panels": PANELS_HEAD } })]);
  });

  it("turns Ship off only for the PR whose side question has a comment", async () => {
    await renderPrs();

    fireEvent.change(screen.getByLabelText("Comment on Keep the stripe colour?"), { target: { value: "Check the contrast." } });

    expect(disabled("Ship example/tiles#1")).toBe(true);
    expect(disabled("Ship example/panels#2")).toBe(false);
  });

  it("keeps a PR's Send back off until it has a note, and then holds the send", async () => {
    await renderPrs();

    expect(disabled("Send back example/panels#2")).toBe(true);
    expect(screen.getByTestId("send-back-note-example/panels#2").textContent).toContain("Send back needs a note");
    fireEvent.change(screen.getByLabelText("Note for Send back on example/panels#2"), { target: { value: "Narrow it again." } });
    fireEvent.click(button("Send back example/panels#2"));
    fireEvent.click(button("Ship example/tiles#1"));
    fireEvent.change(screen.getByLabelText("Note for Send back on example/panels#2"), { target: { value: " " } });

    expect(disabled("Send answers")).toBe(true);
    expect(screen.getByTestId("prs-send-problems").textContent).toContain("add a note to send back example/panels#2");
  });

  it("sends a PR back with its note while a required side question is unanswered (decision 513)", async () => {
    const calls = await renderPrs(await withRequiredSide());

    fireEvent.change(screen.getByLabelText("Note for Send back on example/tiles#1"), { target: { value: "Lower the stripe." } });
    expect(disabled("Send back example/tiles#1")).toBe(false);
    fireEvent.click(button("Send back example/tiles#1"));
    fireEvent.click(button("Ship example/panels#2"));
    fireEvent.click(button("Send answers"));

    expect(submits(calls)).toEqual([
      expect.objectContaining({ answers: [{ questionId: "ship-tiles", pick: "Don't ship", comment: "Lower the stripe." }, { questionId: "ship-panels", pick: "Ship" }] }),
    ]);
  });

  it("shows, once sent, which PR shipped and which went back", async () => {
    await renderPrs({ status: "sent", notes: { general: "", comments: { "ship-panels": "Narrow it again." }, picks: { "ship-tiles": "Ship", "ship-panels": "Don't ship" } } });

    expect(pr("example/tiles#1").getByText("example/tiles#1: shipped at 89abcde; the factory merges it at that head")).toBeTruthy();
    expect(pr("example/panels#2").getByText("example/panels#2: sent back")).toBeTruthy();
    expect(pr("example/panels#2").getByTestId("round-comment-sent-ship-panels").textContent).toContain("Narrow it again.");
    expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
  });
});
