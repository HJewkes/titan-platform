// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS, stagedRound, twoPrRound, type StagedRound } from "../server/round-fixtures.js";
import type { Manifest } from "../server/round-schema.js";
import { getRound, type RoundDetail, type RoundsSource } from "../server/rounds.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";

// Each test renders the whole App and presses through it; see rounds-ship.test.tsx (TP-3866).
const RENDER_TIMEOUT_MS = 30_000;
const ONE_PR = "ship-tile-r1";
const TWO_PR = "tiles-and-panels-r1";
const FRAMES = [
  { key: "tile-light", theme: "light", views: ["head", "base", "diff"] },
  { key: "tile-dark", theme: "dark", views: ["head", "base", "diff"] },
  { key: "panel-wide", theme: "light", views: ["head", "base"] },
  { key: "badge-new", views: ["head"] },
] as const;
const BASE_HEAD = "1234567".padEnd(40, "0");

class SilentObserver {
  observe(): void {}
  disconnect(): void {}
}

let twoPr: StagedRound;
beforeAll(async () => {
  twoPr = await stagedRound("ship-tile-r1", TWO_PR, twoPrRound());
});
afterAll(() => twoPr.remove());
beforeEach(() => vi.stubGlobal("IntersectionObserver", SilentObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

type ValidRound = Extract<RoundDetail, { valid: true }>;

/** The round as the server reads it, with `change` applied to its manifest. */
async function detailOf(source: RoundsSource, id: string, change: (manifest: Manifest) => Manifest = (manifest) => manifest): Promise<ValidRound> {
  const detail = await getRound(source, id);
  if (!detail.valid) throw new Error(`fixture round ${id} is invalid`);
  return { ...detail, manifest: change(detail.manifest) };
}

/** Renders a round over a recorded snapshot; rounds.submit is never reached by these tests. */
async function renderRound(id: string, detail: RoundDetail): Promise<void> {
  const calls = { [snapshotKey("rounds.get", { id })]: successEnvelope(detail), [snapshotKey("rounds.frames", { id })]: successEnvelope({ frames: FRAMES }) };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls }), "text/html");
  const source: DataSource = pageDataSource({ doc: page });
  window.location.hash = `#/rounds/${id}`;
  render(
    <RpcProvider source={source}>
      <AnswerSourceProvider value={source}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  await screen.findAllByTestId("montage-tile-light");
}

const renderOnePr = async (change?: (manifest: Manifest) => Manifest, extra: Partial<ValidRound> = {}) => renderRound(ONE_PR, { ...(await detailOf(FIXTURE_ROUNDS, ONE_PR, change)), ...extra });
const renderTwoPr = async (change?: (manifest: Manifest) => Manifest, extra: Partial<ValidRound> = {}) => renderRound(TWO_PR, { ...(await detailOf(twoPr.source, TWO_PR, change)), ...extra });

const scope = (pr?: string) => (pr === undefined ? screen : within(screen.getByTestId(`pr-${pr}`)));
const openTab = (label: string, pr?: string): void => void fireEvent.click(scope(pr).getByRole("tab", { name: label }));
const panel = (key: string, pr?: string): HTMLElement => (pr === undefined ? screen.getByTestId(`pr-tab-${key}`) : within(screen.getByTestId(`pr-tabs-${pr}`)).getByTestId(`pr-tab-${key}`));
const shown = (element: HTMLElement): boolean => !element.hidden;

describe("Review, Diff and Context tabs on a Ship round (decision 167)", { timeout: RENDER_TIMEOUT_MS }, () => {
  it("opens on Review with the questions, puts the montages in Diff, and keeps the Ship bar under every tab", async () => {
    await renderOnePr();

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent).slice(-3)).toEqual(["Review", "Diff", "Context"]);
    expect(shown(panel("review"))).toBe(true);
    expect(within(panel("review")).getByTestId("ship-side-badge-follow-up")).toBeTruthy();
    expect(within(panel("diff")).getByTestId("montage-tile-light")).toBeTruthy();
    expect(shown(panel("diff"))).toBe(false);
    for (const tab of ["Diff", "Context", "Review"]) {
      openTab(tab);
      expect(screen.getByRole("button", { name: "Ship" })).toBeTruthy();
      expect(panel("review").contains(screen.getByTestId("ship-bar"))).toBe(false);
    }
  });

  it("gives each PR of a two-PR round its own tabs and Ship bar", async () => {
    await renderTwoPr();

    openTab("Diff", "example/panels#2");

    expect(shown(panel("diff", "example/panels#2"))).toBe(true);
    expect(shown(panel("review", "example/tiles#1"))).toBe(true);
    expect(within(panel("review", "example/tiles#1")).getByText("Keep the stripe colour?")).toBeTruthy();
    expect(scope("example/panels#2").getByRole("button", { name: "Ship example/panels#2" })).toBeTruthy();
    expect(scope("example/tiles#1").getByRole("button", { name: "Ship example/tiles#1" })).toBeTruthy();
  });
});

describe("the Context tab (harness PrTabs Context)", { timeout: RENDER_TIMEOUT_MS }, () => {
  const group: Partial<NonNullable<Manifest["prGroups"]>[number]> = { task: { id: "EX-1", title: "Lift the stripe", doneWhen: "The stripe clears the label." }, codewatch: "No new cycles.", files: [{ path: "src/tile.css", status: "modified" }, { path: "src/badge.tsx" }] };

  it("shows the PR's description, task done-when, codewatch report and changed files", async () => {
    await renderTwoPr((manifest) => ({ ...manifest, prGroups: manifest.prGroups?.map((each) => (each.pr === "example/tiles#1" ? { ...each, ...group } : each)) }));
    openTab("Context", "example/tiles#1");
    const context = within(screen.getByTestId("context-example/tiles#1"));

    expect(context.getByTestId("description-example/tiles#1").textContent).toContain("Moves the stripe up six pixels");
    expect(context.getByText("TASK EX-1: LIFT THE STRIPE, DONE WHEN")).toBeTruthy();
    expect(context.getByTestId("done-when-example/tiles#1").textContent).toContain("The stripe clears the label.");
    expect(context.getByTestId("codewatch-example/tiles#1").textContent).toContain("No new cycles.");
    expect(within(context.getByTestId("context-files")).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["src/tile.css modified", "src/badge.tsx"]);
  });

  it("says not recorded for each field a round leaves out", async () => {
    await renderOnePr();
    openTab("Context");
    const context = within(screen.getByTestId("context-example/tiles#1"));

    for (const part of ["context-description", "context-task", "context-codewatch", "context-files"]) expect(within(context.getByTestId(part)).getByText("not recorded")).toBeTruthy();
  });
});

describe("stacked rounds (decision 95(3))", { timeout: RENDER_TIMEOUT_MS }, () => {
  /** Panels sits on tiles; the round's base-frames section shows a PR below both that no question asks about. */
  const stacked = (manifest: Manifest): Manifest => ({
    ...manifest,
    sections: [...manifest.sections.map((each) => (each.id === "panels-changed" ? { ...each, variantKeys: ["panel-wide"] } : each)), { id: "base-frames", title: "example/base#7 frames", deciding: "Nothing.", changed: "Nothing.", context: "Context only.", questionIds: [], variantKeys: ["badge-new"], seeAlso: [] }],
    stackedOn: { repo: "example/base", pr: 7, headSha: BASE_HEAD },
    prGroups: manifest.prGroups?.map((each) => (each.pr === "example/panels#2" ? { ...each, stackedOn: { repo: "example/tiles", pr: 1, headSha: BASE_HEAD } } : each)),
  });

  it("labels a base PR's frames as context and says which PR a stacked one ships after", async () => {
    await renderTwoPr(stacked);

    expect(screen.getByTestId("montage-badge-new").textContent).toContain("base PR #7, not under review: Badge (new at head)");
    expect(scope("example/panels#2").getByTestId("ships-after-ship-panels").textContent).toBe("ships after example/tiles#1");
    expect(scope("example/tiles#1").queryByTestId("ships-after-ship-tiles")).toBeNull();
  });

  it("turns the stacked PR's Ship off while its holder is sent back, linking to the holder's Ship question (TP-3883)", async () => {
    await renderTwoPr(stacked);
    const panelsShip = () => scope("example/panels#2").getByRole("button", { name: "Ship example/panels#2" });
    expect(panelsShip().getAttribute("aria-disabled")).not.toBe("true");

    fireEvent.change(scope("example/tiles#1").getByLabelText("Note for Send back on example/tiles#1"), { target: { value: "Lower the stripe." } });
    fireEvent.click(scope("example/tiles#1").getByRole("button", { name: "Send back example/tiles#1" }));

    expect(panelsShip().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(scope("example/panels#2").getByTestId("ship-blocked")).getByText('stacked on example/tiles#1, which may not ship: it is answered "Don\'t ship"'));
    expect(document.activeElement?.id).toBe("ship-question-ship-tiles");
    fireEvent.click(scope("example/tiles#1").getByRole("button", { name: "Ship example/tiles#1" }));
    expect(panelsShip().getAttribute("aria-disabled")).not.toBe("true");
  });
});

describe("Ship bar blockers link to what they name (harness PrTabs ShipBar)", { timeout: RENDER_TIMEOUT_MS }, () => {
  const blocker = (text: string): HTMLElement => within(screen.getByTestId("ship-blocked")).getByText(text);
  const PRIOR = [{ round: 1, submittedAt: "2031-03-04T00:00:00.000Z", comment: "Lift the stripe." }];

  it("takes a question's blocker back to the Review tab and focuses the question", async () => {
    await renderOnePr();
    fireEvent.change(screen.getByLabelText("Comment on File the badge colour as a follow-up?"), { target: { value: "Ask design." } });
    openTab("Context");

    fireEvent.click(blocker('you left a comment on "File the badge colour as a follow-up?"'));

    expect(shown(panel("review"))).toBe(true);
    expect(document.activeElement?.id).toBe("ship-question-badge-follow-up");
  });

  it("takes a frame's blocker to the Diff tab and focuses the frame", async () => {
    await renderOnePr();
    openTab("Diff");
    fireEvent.click(within(screen.getByTestId("montage-tile-dark")).getByRole("button", { name: "Rejected" }));
    openTab("Review");

    fireEvent.click(blocker('you left feedback on frame "Tile, dark"'));

    expect(shown(panel("diff"))).toBe(true);
    expect(document.activeElement?.id).toBe("ship-frame-tile-dark");
  });

  it("focuses an unticked earlier round's Addressed card, and the round note's field", async () => {
    await renderOnePr(undefined, { priorFeedback: PRIOR });
    fireEvent.change(screen.getByLabelText("Feedback on this round"), { target: { value: "One more thing." } });

    fireEvent.click(blocker("your feedback from round 1 is not ticked Addressed"));
    expect(document.activeElement?.id).toBe("ship-prior-example/tiles#1-1");
    fireEvent.click(blocker("you left feedback on this round"));

    expect(document.activeElement).toBe(screen.getByLabelText("Feedback on this round"));
  });

  it("shows each PR of a two-PR round only its own earlier feedback, one Addressed card per tab (TP-3790)", async () => {
    const at = "2031-03-04T00:00:00.000Z";
    await renderTwoPr(undefined, {
      priorFeedback: [
        { round: 1, submittedAt: at, comment: "Lift the stripe.", pr: "example/tiles#1" },
        { round: 1, submittedAt: at, comment: "Narrow the panel.", pr: "example/panels#2" },
      ],
    });
    const cards = (pr: string) => within(panel("review", pr)).getAllByRole("checkbox", { name: "Round 1 feedback addressed" });

    expect(cards("example/tiles#1")).toHaveLength(1);
    expect(cards("example/panels#2")).toHaveLength(1);
    expect(within(panel("review", "example/tiles#1")).getByText("Lift the stripe.")).toBeTruthy();
    expect(within(panel("review", "example/tiles#1")).queryByText("Narrow the panel.")).toBeNull();
    fireEvent.click(within(scope("example/panels#2").getByTestId("ship-bar")).getByText("your feedback from round 1 is not ticked Addressed"));
    expect(document.activeElement?.id).toBe("ship-prior-example/panels#2-1");
  });

  it("ticks an earlier round Addressed on one PR's card only, and a reload keeps it there (TP-3885)", async () => {
    const at = "2031-03-04T00:00:00.000Z";
    const priorFeedback = [
      { round: 1, submittedAt: at, comment: "Lift the stripe.", pr: "example/tiles#1" },
      { round: 1, submittedAt: at, comment: "Narrow the panel.", pr: "example/panels#2" },
    ];
    const card = (pr: string) => within(panel("review", pr)).getByRole("checkbox", { name: "Round 1 feedback addressed" });
    const shipOff = (pr: string) => scope(pr).getByRole("button", { name: `Ship ${pr}` }).getAttribute("aria-disabled") === "true";
    await renderTwoPr(undefined, { priorFeedback });

    fireEvent.click(card("example/tiles#1"));

    expect([card("example/tiles#1"), card("example/panels#2")].map((each) => each.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect([shipOff("example/tiles#1"), shipOff("example/panels#2")]).toEqual([false, true]);
    cleanup();
    await renderTwoPr(undefined, { priorFeedback });
    expect([card("example/tiles#1"), card("example/panels#2")].map((each) => each.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("never lists an unanswered question, even a required one, so Ship stays on (decision 166)", async () => {
    await renderOnePr((manifest) => ({ ...manifest, questions: manifest.questions.map((each) => ({ ...each, required: true })) }));

    expect(screen.queryByTestId("ship-blocked")).toBeNull();
    expect(screen.getByRole("button", { name: "Ship" }).getAttribute("aria-disabled")).not.toBe("true");
  });
});
