// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { PANELS_HEAD, TILES_HEAD, stagedRound, twoPrRound, type StagedRound } from "../server/round-fixtures.js";
import { getFrame } from "../server/round-frames.js";
import { getRound, type RoundDetail } from "../server/rounds.js";
import { getButton, getByRoleFast } from "./pages/get-button.test-helpers.js";
import { draftKey } from "./pages/round-draft.js";
import { renderPage } from "./render-page.test-helpers.js";

const ROUND = "tiles-and-panels-r1";
// Each test renders the whole App and presses through it, and a loaded full-suite CI run stretched one past vitest's
// 5 s default (TP-3937, as TP-3866 saw for the one-PR Ship tests). The assertions, not the clock, catch a wrong answer.
const RENDER_TIMEOUT_MS = 30_000;
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
  localStorage.clear();
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
async function renderPrs(detail: Partial<RoundDetail> = {}, { inApp = false } = {}): Promise<{ name: string; args: unknown }[]> {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", await recorded(detail)), "text/html");
  const inner = pageDataSource({ doc: page });
  const calls: { name: string; args: unknown }[] = [];
  const submitted = successEnvelope({ status: "submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: null });
  const counting: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (calls.push({ name, args }), name === "rounds.submit" ? Promise.resolve(submitted) : inner.call(name, args, options)),
  };
  renderPage(counting, `#/rounds/${ROUND}`, { answers: counting, inApp });
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
const button = (label: string): HTMLElement => getButton(label);
const disabled = (label: string): boolean => button(label).getAttribute("aria-disabled") === "true";
const submits = (calls: { name: string; args: unknown }[]) => calls.filter((call) => call.name === "rounds.submit").map((call) => call.args);

describe("a Ship round with two PRs (TP-3329)", { timeout: RENDER_TIMEOUT_MS }, () => {
  it("shows each PR's proposal, changes and only its own frames", async () => {
    await renderPrs({}, { inApp: true });

    expect(pr("example/tiles#1").getByTestId("description-example/tiles#1").textContent).toContain("Moves the stripe up six pixels");
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
    expect(screen.getByTestId("send-back-note-example/panels#2").textContent).toContain("Send back needs a note: say what to fix");
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
    await renderPrs({ status: "sent", notes: { general: "", comments: { "ship-panels": "Narrow it again." }, answers: { "ship-tiles": { pick: "Ship" }, "ship-panels": { pick: "Don't ship" } }, addressed: [] } });

    expect(pr("example/tiles#1").getByText("example/tiles#1: shipped at 89abcde; the factory merges it at that head")).toBeTruthy();
    expect(pr("example/panels#2").getByText("example/panels#2: sent back")).toBeTruthy();
    expect(pr("example/panels#2").getByTestId("round-comment-sent-ship-panels").textContent).toContain("Narrow it again.");
    expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
  });

  it("keeps the earlier feedback once sent, with its Addressed tick locked as sent (TP-3824)", async () => {
    const priorFeedback = [{ round: 1, submittedAt: "2031-03-04T00:00:00.000Z", pick: "Don't ship", comment: "The stripe is two pixels low." }];
    await renderPrs({ status: "sent", priorFeedback, notes: { general: "", comments: {}, answers: { "ship-tiles": { pick: "Ship" }, "ship-panels": { pick: "Ship" } }, addressed: [1] } });

    // An entry with no `pr` bears on every PR, so each PR's Review tab shows it (TP-3790).
    expect(pr("example/panels#2").getByTestId("ship-prior-feedback").textContent).toContain("The stripe is two pixels low.");
    const prior = pr("example/tiles#1").getByTestId("ship-prior-feedback");
    expect(prior.textContent).toContain("The stripe is two pixels low.");
    const addressed = getByRoleFast("checkbox", "Round 1 feedback addressed", prior);
    expect(addressed.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(addressed);
    expect(addressed.getAttribute("aria-checked")).toBe("true");
  });
});

describe("frame feedback on a Ship round with two PRs (TP-3773 S6b)", { timeout: RENDER_TIMEOUT_MS }, () => {
  const verdict = (key: string, frame: string, label: string): HTMLElement => {
    fireEvent.click(getByRoleFast("tab", "Diff", screen.getByTestId(`pr-${key}`)));
    return getButton(label, pr(key).getByTestId(`montage-${frame}`));
  };

  it("turns Ship off only for the PR whose own frame is Rejected, and sends the verdict", async () => {
    const calls = await renderPrs();

    fireEvent.click(verdict("example/panels#2", "panel-wide", "Rejected"));

    expect(disabled("Ship example/panels#2")).toBe(true);
    expect(pr("example/panels#2").getByTestId("ship-blocked").textContent).toContain('you left feedback on frame "Panel, wider"');
    expect(disabled("Ship example/tiles#1")).toBe(false);
    fireEvent.click(button("Ship example/tiles#1"));
    fireEvent.change(screen.getByLabelText("Note for Send back on example/panels#2"), { target: { value: "Narrow it again." } });
    fireEvent.click(button("Send back example/panels#2"));
    fireEvent.click(button("Send answers"));
    expect(submits(calls)).toEqual([expect.objectContaining({ variants: [{ key: "panel-wide", verdict: "rejected" }] })]);
  });

  it("takes a comment on a PR's own frame as its Send back note, never one on the other PR's frame", async () => {
    await renderPrs();

    fireEvent.change(screen.getByLabelText("Comment on frame Tile, dark"), { target: { value: "Darker stripe." } });
    expect(disabled("Send back example/panels#2")).toBe(true);
    expect(disabled("Send back example/tiles#1")).toBe(false);
  });
});

describe("an unsent two-PR Ship round's draft (TP-3870)", { timeout: RENDER_TIMEOUT_MS }, () => {
  const noteOn = (key: string): string => screen.getByLabelText<HTMLTextAreaElement>(`Note for Send back on ${key}`).value;

  it("restores each PR's own Ship or Send back and note after a remount, and sends them as held", async () => {
    await renderPrs();
    fireEvent.click(button("Ship example/tiles#1"));
    fireEvent.change(screen.getByLabelText("Note for Send back on example/panels#2"), { target: { value: "Narrow it again." } });
    fireEvent.click(button("Send back example/panels#2"));
    await waitFor(() => expect(localStorage.getItem(draftKey(ROUND))).toContain("Narrow it again."));
    cleanup();

    const calls = await renderPrs();

    // A PR held at Ship shows no note box; with both PRs decided the one send is on before any press.
    expect(screen.queryByLabelText("Note for Send back on example/tiles#1")).toBeNull();
    expect(noteOn("example/panels#2")).toBe("Narrow it again.");
    expect(disabled("Send answers")).toBe(false);
    fireEvent.click(button("Send answers"));
    expect(submits(calls)).toEqual([
      expect.objectContaining({ answers: [{ questionId: "ship-tiles", pick: "Ship" }, { questionId: "ship-panels", pick: "Don't ship", comment: "Narrow it again." }], heads: { "ship-tiles": TILES_HEAD } }),
    ]);
  });
});
