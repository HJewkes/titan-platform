// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS as source } from "../server/round-fixtures.js";
import type { Question } from "../server/round-schema.js";
import { getFrame } from "../server/round-frames.js";
import { getRound, listRounds, type RoundDetail } from "../server/rounds.js";
import { App } from "./App.js";
import { getButton, getByRoleFast } from "./pages/get-button.test-helpers.js";
import { draftKey } from "./pages/round-draft.js";
import { renderPage } from "./render-page.test-helpers.js";

const SHIP = "ship-tile-r1";
// Each test renders the whole App and presses through it: about 0.5 s alone, and a loaded full-suite CI run stretched
// one past vitest's 5 s default (TP-3866). The assertions, not the clock, are what fail on a wrong answer.
const RENDER_TIMEOUT_MS = 30_000;
const HEAD = "89abcdef0123456789abcdef0123456789abcdef";
const SHIP_RECOMMENDATION = { answer: "Ship", rationale: "The stripe moved as the change intends and nothing else shifted.", confidence: 0.8, by: "fixture-agent" };
const FRAMES = [
  { key: "tile-light", theme: "light", views: ["head", "base", "diff"] },
  { key: "tile-dark", theme: "dark", views: ["head", "base", "diff"] },
  { key: "panel-wide", theme: "light", views: ["head", "base"] },
  { key: "badge-new", views: ["head"] },
] as const;
const IMAGE_COUNT = FRAMES.reduce((sum, frame) => sum + frame.views.length, 0);

/** jsdom has no IntersectionObserver: this one fires only when a test calls `scrollAll`. */
const observers = new Set<{ fire: () => void }>();
type Entry = Pick<IntersectionObserverEntry, "target" | "isIntersecting">;
class StubObserver {
  private readonly targets: Element[] = [];
  constructor(private readonly callback: (entries: Entry[]) => void) {
    observers.add(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  disconnect(): void {
    observers.delete(this);
  }
  fire(): void {
    this.callback(this.targets.map((target) => ({ target, isIntersecting: true })));
  }
}

const scrollAll = (): void => act(() => [...observers].forEach((observer) => observer.fire()));

beforeEach(() => vi.stubGlobal("IntersectionObserver", StubObserver));
afterEach(() => {
  cleanup();
  observers.clear();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** A CI packet's tile-light: its head is the montage and `after` the changed image alone. */
const PACKET_FRAMES = [{ key: "tile-light", theme: "light", views: ["head", "base", "after", "diff"] }, ...FRAMES.slice(1)];

/** The daemon's answers over the synthetic Ship fixture; `detail` overrides the recorded rounds.get fields. */
async function recorded(detail: Partial<RoundDetail> = {}, listed: readonly unknown[] = FRAMES): Promise<Snapshot> {
  const frames = await Promise.all(
    FRAMES.flatMap(({ key, views }) => views.map(async (view) => [snapshotKey("rounds.frame", { id: SHIP, key, view }), successEnvelope(await getFrame(source, SHIP, key, view))] as const)),
  );
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: {
      [snapshotKey("rounds.get", { id: SHIP })]: successEnvelope({ ...(await getRound(source, SHIP)), ...detail }),
      [snapshotKey("rounds.frames", { id: SHIP })]: successEnvelope({ frames: listed }),
      ...Object.fromEntries(frames),
      [snapshotKey("rounds.frame", { id: SHIP, key: "tile-light", view: "after" })]: successEnvelope(await getFrame(source, SHIP, "tile-light", "head")),
    },
  };
}

interface Rendered {
  calls: { name: string; args: unknown }[];
}

/** Renders the Ship round over a recorded snapshot; with `answers` the page may send, and rounds.submit answers "submitted". */
async function renderShip(options: { answers?: boolean; detail?: Partial<RoundDetail>; listed?: readonly unknown[] } = {}): Promise<Rendered> {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", await recorded(options.detail, options.listed)), "text/html");
  const inner = pageDataSource({ doc: page });
  const calls: Rendered["calls"] = [];
  const submitted = successEnvelope({ status: "submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: HEAD });
  const revealed = successEnvelope({ recommendation: SHIP_RECOMMENDATION, recorded: true });
  const replies: Record<string, ReturnType<typeof successEnvelope>> = { "rounds.submit": submitted, "rounds.reveal": revealed };
  const counting: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, callOptions) => (calls.push({ name, args }), replies[name] ? Promise.resolve(replies[name]) : inner.call(name, args, callOptions)),
  };
  renderPage(counting, { view: "rounds", id: SHIP }, { answers: options.answers ? counting : null });
  await screen.findByTestId("montage-tile-light");
  return { calls };
}

const panelLabels = (key: string): string[] => within(screen.getByTestId(`montage-${key}`)).getAllByText(/^(BEFORE \(main\)|AFTER \(head\)|DIFF)$/).map((label) => label.textContent);
const button = (label: string): HTMLElement => getButton(label);
/** The montages sit under the Diff tab (decision 167). */
const openDiff = (): void => void fireEvent.click(getByRoleFast("tab", "Diff"));
const frameCalls = ({ calls }: Rendered) => calls.filter((call) => call.name === "rounds.frame");

describe("the Ship view", { timeout: RENDER_TIMEOUT_MS }, () => {
  it("renders a merge-bound round as the Ship view with its PR head, not the design notice", async () => {
    await renderShip();

    expect(screen.getByText("Ships example/tiles#1 at 89abcde")).toBeTruthy();
    expect(screen.queryByText("design round: open in the harness")).toBeNull();
  });

  it("shows the proven head's lineage before the Ship answer, and lineage unknown where none was read", async () => {
    const lineage = { known: true, provenSha: HEAD, state: "open", merged: false, mergeSha: null, headSha: HEAD, baseRef: "main", baseSha: "1".repeat(40), behind: 3 } as const;
    await renderShip({ detail: { lineage } });
    expect(screen.getByTestId("ship-lineage").textContent).toBe("proven at 89abcdeUNMERGEDmain 11111113 behind");
    cleanup();

    await renderShip();
    expect(screen.getByTestId("ship-lineage").textContent).toBe("lineage unknownno GitHub reader is wired");
  });

  it("labels the Ship round in the rounds list", async () => {
    const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls: { [snapshotKey("rounds.list", {})]: successEnvelope(await listRounds(source)) } }), "text/html");
    window.location.hash = "#/rounds";
    render(<RpcProvider source={pageDataSource({ doc: page })}><App /></RpcProvider>);

    expect(within(await screen.findByTestId(`round-row-${SHIP}`)).getByText("ship")).toBeTruthy();
  });

  it("shows a changed image as BEFORE (main), AFTER (head) and DIFF, and a new one as NEW with AFTER (head) only", async () => {
    await renderShip();

    expect(panelLabels("tile-light")).toEqual(["BEFORE (main)", "AFTER (head)", "DIFF"]);
    expect(panelLabels("badge-new")).toEqual(["AFTER (head)"]);
    expect(within(screen.getByTestId("montage-badge-new")).getByText("NEW")).toBeTruthy();
    expect(within(screen.getByTestId("montage-tile-light")).queryByText("NEW")).toBeNull();
  });

  it("pairs the light and dark renders of one image", async () => {
    await renderShip();

    const pair = screen.getByTestId("theme-pair-tile-light");
    expect(within(pair).getByTestId("montage-tile-dark")).toBeTruthy();
    expect(within(pair).getByText("light")).toBeTruthy();
    expect(within(pair).getByText("dark")).toBeTruthy();
    expect(screen.queryByTestId("theme-pair-panel-wide")).toBeNull();
  });

  it("fetches no image until it nears the viewport, then one call per image", async () => {
    const rendered = await renderShip();
    expect(frameCalls(rendered)).toHaveLength(0);

    openDiff();
    scrollAll();

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(IMAGE_COUNT));
    expect(frameCalls(rendered)).toHaveLength(IMAGE_COUNT);
    expect(frameCalls(rendered)).toContainEqual({ name: "rounds.frame", args: { id: SHIP, key: "tile-dark", view: "diff" } });
  });

  it("offers no Pin on a montage, whose BEFORE, AFTER and DIFF would share one frame's pins", async () => {
    await renderShip({ answers: true });
    const montage = screen.getByTestId("montage-tile-light");
    fireEvent.pointerDown(montage);

    fireEvent.keyDown(window, { key: "a" });

    expect(within(montage).queryByRole("button", { name: /^Pin / })).toBeNull();
    expect(within(montage).queryByText(/place a pin/)).toBeNull();
  });

  it("reads AFTER from a CI packet's after image, not its montage head", async () => {
    const rendered = await renderShip({ listed: PACKET_FRAMES });

    scrollAll();

    await waitFor(() => expect(frameCalls(rendered)).toHaveLength(IMAGE_COUNT));
    expect(frameCalls(rendered)).toContainEqual({ name: "rounds.frame", args: { id: SHIP, key: "tile-light", view: "after" } });
    expect(frameCalls(rendered)).not.toContainEqual({ name: "rounds.frame", args: { id: SHIP, key: "tile-light", view: "head" } });
  });

  it("keeps the recommendation out of the page while the round is open", async () => {
    await renderShip();

    expect(screen.queryByText(/^Recommended:/)).toBeNull();
    expect(screen.queryByText(/nothing else shifted/)).toBeNull();
  });

  it("names what ships: the PR, its head and the changed-frame count", async () => {
    await renderShip();

    expect(screen.getByTestId("what-ships").textContent).toBe("What ships: example/tiles#1 at 89abcde, 4 changed frames");
  });

  it("puts changed frames first and folds unchanged pairs into an N unchanged disclosure", async () => {
    const listed = FRAMES.map((frame) => ({ ...frame, unchanged: frame.key === "tile-light" }));
    await renderShip({ listed });

    const order = screen.getAllByTestId(/^montage-/).map((montage) => montage.dataset.testid);
    const folded = screen.getByTestId("unchanged-frames");
    expect(order).toEqual(["montage-tile-dark", "montage-badge-new", "montage-panel-wide", "montage-tile-light"]);
    expect(within(folded).getByText("1 unchanged: main and head render the same")).toBeTruthy();
    expect(within(folded).getByTestId("montage-tile-light")).toBeTruthy();
    expect(within(folded).queryByTestId("montage-tile-dark")).toBeNull();
    expect(screen.getByTestId("what-ships").textContent).toBe("What ships: example/tiles#1 at 89abcde, 3 changed frames");
  });

  it("shows no unchanged disclosure when every frame changed", async () => {
    await renderShip();

    expect(screen.queryByTestId("unchanged-frames")).toBeNull();
  });

  it("opens an image full size when pressed and closes on Escape", async () => {
    await renderShip();
    openDiff();
    scrollAll();

    fireEvent.click(await screen.findByRole("button", { name: "Enlarge Badge (new), after" }));
    expect(screen.getByRole("dialog", { name: "Badge (new), after" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("answering a Ship round", { timeout: RENDER_TIMEOUT_MS }, () => {
  const submits = ({ calls }: Rendered) => calls.filter((call) => call.name === "rounds.submit").map((call) => call.args);

  it("sends Ship bound to the question's head sha and the round.json shown", async () => {
    const rendered = await renderShip({ answers: true });
    const detail = await getRound(source, SHIP);
    if (!detail.valid) throw new Error("the Ship fixture is not a valid round");
    const { manifestSha256 } = detail;

    fireEvent.click(button("Ship"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toEqual({ id: SHIP, manifestSha256, general: "", headSha: HEAD, answers: [{ questionId: "ship-tiles", pick: "Ship" }] });
    expect(await screen.findByText("Waiting for the factory")).toBeTruthy();
  });

  it("reveals the Ship recommendation on demand and tags the Ship pressed after it seen", async () => {
    const rendered = await renderShip({ answers: true });

    // react-native-web hands a Pressable its new onPress in a passive effect, so the reveal must settle inside act
    // or a loaded runner presses Ship while it still holds the pre-reveal draft.
    await act(async () => {
      fireEvent.click(screen.getByTestId("reveal-ship-tiles"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText("Recommended: Ship (80%, fixture-agent)")).toBeTruthy();
    fireEvent.click(button("Ship"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(rendered.calls.filter((call) => call.name === "rounds.reveal").map((call) => call.args)).toEqual([{ id: SHIP, manifestSha256: expect.any(String), questionId: "ship-tiles" }]);
    expect(submits(rendered)[0]).toMatchObject({ answers: [{ questionId: "ship-tiles", pick: "Ship", recommendationSeen: true }] });
  });

  it("sends Send back as the other option, with the owner's note as its comment and no head sha", async () => {
    const rendered = await renderShip({ answers: true });

    fireEvent.change(screen.getByLabelText("Note for Send back"), { target: { value: "  The stripe is two pixels low.  " } });
    fireEvent.click(button("Send back"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({ answers: [{ questionId: "ship-tiles", pick: "Don't ship", comment: "The stripe is two pixels low." }] });
    expect(submits(rendered)[0]).not.toHaveProperty("headSha");
  });

  it("offers a comment on its side question and feedback on the round, and sends both with Send back", async () => {
    const rendered = await renderShip({ answers: true });

    fireEvent.change(screen.getByLabelText("Comment on File the badge colour as a follow-up?"), { target: { value: "Only if design agrees." } });
    fireEvent.change(screen.getByLabelText("Feedback on this round"), { target: { value: "The diffs made this easy." } });
    fireEvent.click(button("Send back"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({
      general: "The diffs made this easy.",
      answers: [{ questionId: "badge-follow-up", comment: "Only if design agrees." }, { questionId: "ship-tiles", pick: "Don't ship" }],
    });
  });

  it("shows a sent Ship round's comments and round feedback read-only", async () => {
    const notes = { general: "The diffs made this easy.", comments: { "badge-follow-up": "Only if design agrees.", "ship-tiles": "Stripe is low." }, answers: {}, addressed: [] };
    await renderShip({ answers: true, detail: { status: "sent", notes } });

    expect(screen.getByTestId("round-comment-sent-badge-follow-up").textContent).toContain("Only if design agrees.");
    expect(screen.getByTestId("round-comment-sent-ship-tiles").textContent).toContain("Stripe is low.");
    expect(screen.getByTestId("round-general-sent").textContent).toContain("The diffs made this easy.");
    expect(screen.queryByLabelText("Feedback on this round")).toBeNull();
  });

  it("disables both answers on a snapshot page and sends nothing", async () => {
    const rendered = await renderShip();

    fireEvent.click(button("Ship"));
    fireEvent.click(button("Send back"));

    expect(button("Ship").getAttribute("aria-disabled")).toBe("true");
    expect(button("Send back").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("This page is a snapshot: answer from the live console.")).toBeTruthy();
    expect(submits(rendered)).toHaveLength(0);
  });

  it("never says Merging for a resolved Send back", async () => {
    await renderShip({ answers: true, detail: { status: "sent", answer: { status: "resolved", at: "2031-03-05T00:01:00.000Z", choice: "send-back" } } });

    expect(screen.getByText("Sent back: the implementer gets your note")).toBeTruthy();
    expect(screen.queryByText(/^Merging at/)).toBeNull();
  });

  it.each([
    [undefined, "Waiting for the factory"],
    [{ status: "resolved", at: "2031-03-05T00:01:00.000Z", choice: "merge" }, "Merging at 89abcde"],
    [{ status: "resolved", at: "2031-03-05T00:01:00.000Z", choice: "send-back" }, "Sent back: the implementer gets your note"],
    [{ status: "resolved", at: "2031-03-05T00:01:00.000Z" }, "Answer applied"],
    [{ status: "moved", at: "2031-03-05T00:01:00.000Z", currentHead: "fedcba9876543210fedcba9876543210fedcba98" }, "Head moved to fedcba9; a new round follows"],
    [{ status: "refused", at: "2031-03-05T00:01:00.000Z", reason: "the gate is held" }, "Not applied: the gate is held"],
  ] as const)("shows a sent round's gate outcome %j as %j in place of the buttons", async (answer, line) => {
    await renderShip({ answers: true, detail: { status: "sent", answer } });

    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ship" })).toBeNull();
  });
});

describe("answering a Ship round with side questions", { timeout: RENDER_TIMEOUT_MS }, () => {
  const submits = ({ calls }: Rendered) => calls.filter((call) => call.name === "rounds.submit").map((call) => call.args);

  /** The td850 shape: three side questions, then the Ship decision last. */
  async function td850(requiredScale = false): Promise<Partial<RoundDetail>> {
    const detail = await getRound(source, SHIP);
    if (!detail.valid) throw new Error("the Ship fixture is not a valid round");
    const ship = detail.manifest.questions.find((question) => question.id === "ship-tiles");
    if (ship === undefined) throw new Error("the Ship fixture has no ship-tiles question");
    const side: Question[] = [
      { id: "side-colour", kind: "pick-one", prompt: "File the badge colour as a follow-up?", options: ["Yes", "No"], signsOff: "badge-colour" },
      { id: "side-columns", kind: "pick-many", prompt: "Which tiles need a second look?", options: ["Light", "Dark", "Wide"] },
      { id: "side-clarity", kind: "scale", prompt: "How clear is the stripe?", min: 1, max: 5, ...(requiredScale ? { required: true } : {}) },
      { id: "side-note", kind: "text", prompt: "Anything else?" },
    ];
    return { manifest: { ...detail.manifest, questions: [...side, ship] } };
  }

  it("sends every side answer with the Ship pick in one rounds.submit, in the round's question order", async () => {
    const rendered = await renderShip({ answers: true, detail: await td850() });

    fireEvent.click(getByRoleFast("radio", "1 Yes"));
    fireEvent.click(getByRoleFast("checkbox", "1 Light"));
    fireEvent.click(getByRoleFast("checkbox", "3 Wide"));
    fireEvent.click(getByRoleFast("radio", "4 4"));
    fireEvent.change(screen.getByLabelText("Answer to Anything else?"), { target: { value: "Looks fine." } });
    fireEvent.click(button("Ship"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({
      headSha: HEAD,
      answers: [
        { questionId: "side-colour", pick: "Yes" },
        { questionId: "side-columns", picks: ["Light", "Wide"] },
        { questionId: "side-clarity", value: 4 },
        { questionId: "side-note", text: "Looks fine." },
        { questionId: "ship-tiles", pick: "Ship" },
      ],
    });
  });

  it("sends the side answers with Send back too, and leaves unanswered optional questions out", async () => {
    const rendered = await renderShip({ answers: true, detail: await td850() });

    fireEvent.click(getByRoleFast("radio", "2 No"));
    fireEvent.change(screen.getByLabelText("Note for Send back"), { target: { value: "The stripe is low." } });
    fireEvent.click(button("Send back"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({ answers: [{ questionId: "side-colour", pick: "No" }, { questionId: "ship-tiles", pick: "Don't ship", comment: "The stripe is low." }] });
  });

  it("keeps both answers on while a required side question is empty, and sends it unanswered (decisions 166 and 513)", async () => {
    const rendered = await renderShip({ answers: true, detail: await td850(true) });
    expect(button("Ship").getAttribute("aria-disabled")).not.toBe("true");

    fireEvent.change(screen.getByLabelText("Note for Send back"), { target: { value: "The stripe is low." } });
    expect(button("Send back").getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(button("Send back"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({ answers: [{ questionId: "ship-tiles", pick: "Don't ship", comment: "The stripe is low." }] });
  });

  it("holds Send back until there is a note the fixer will get, in the Ship comment or the round note", async () => {
    const rendered = await renderShip({ answers: true, detail: await td850() });
    fireEvent.change(screen.getByLabelText("Answer to Anything else?"), { target: { value: "The stripe is low." } });

    expect(screen.getByTestId("send-back-blocked").textContent).toContain("Send back needs a note: say what to fix in the Ship comment or the round note.");
    expect(button("Send back").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button("Send back"));
    expect(submits(rendered)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Feedback on this round"), { target: { value: "Lift the stripe." } });
    expect(screen.queryByTestId("send-back-blocked")).toBeNull();
    fireEvent.click(button("Send back"));
    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
  });

  it("no longer calls the side questions read-only", async () => {
    await renderShip({ answers: true, detail: await td850() });

    expect(screen.queryByText(/not sent/)).toBeNull();
  });
});

describe("Ship while feedback is open (TP-3741)", { timeout: RENDER_TIMEOUT_MS }, () => {
  const submits = ({ calls }: Rendered) => calls.filter((call) => call.name === "rounds.submit").map((call) => call.args);
  const PRIOR = [{ round: 1, submittedAt: "2031-03-04T00:00:00.000Z", pick: "Don't ship", comment: "The stripe is two pixels low." }];
  const blocked = (): string => screen.getByTestId("ship-blocked").textContent;

  it("shows round 1's Don't ship and note, and keeps Ship off until it is ticked Addressed", async () => {
    const rendered = await renderShip({ answers: true, detail: { priorFeedback: PRIOR } });

    const prior = screen.getByTestId("ship-prior-feedback");
    expect(within(prior).getByText("Your feedback from round 1")).toBeTruthy();
    expect(within(prior).getByText("Don't ship")).toBeTruthy();
    expect(within(prior).getByText("The stripe is two pixels low.")).toBeTruthy();
    expect(blocked()).toContain("your feedback from round 1 is not ticked Addressed");
    expect(button("Ship").getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(screen.getByLabelText("Note for Send back"), { target: { value: "Still low." } });
    expect(button("Send back").getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(button("Ship"));
    expect(submits(rendered)).toHaveLength(0);

    fireEvent.click(getByRoleFast("checkbox", "Round 1 feedback addressed"));
    expect(screen.queryByTestId("ship-blocked")).toBeNull();
    fireEvent.click(button("Ship"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({ addressed: [1], headSha: HEAD, answers: [{ questionId: "ship-tiles", pick: "Ship" }] });
  });

  it("turns Ship off while a comment is typed, and back on once it is cleared", async () => {
    await renderShip({ answers: true });
    const comment = screen.getByLabelText("Comment on File the badge colour as a follow-up?");

    fireEvent.change(comment, { target: { value: "Only if design agrees." } });
    expect(blocked()).toBe('⚠Ship is off until you clear these; Send back stays open.you left a comment on "File the badge colour as a follow-up?"');
    expect(button("Ship").getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(comment, { target: { value: "" } });
    expect(screen.queryByTestId("ship-blocked")).toBeNull();
  });

  it("turns Ship off for a side pick that differs from the implemented choice", async () => {
    const detail = await getRound(source, SHIP);
    if (!detail.valid) throw new Error("the Ship fixture is not a valid round");
    const questions = detail.manifest.questions.map((question) => (question.id === "badge-follow-up" && question.kind === "pick-one" ? { ...question, implemented: "Yes" } : question));
    await renderShip({ answers: true, detail: { manifest: { ...detail.manifest, questions } } });

    fireEvent.click(getByRoleFast("radio", "2 No"));

    expect(blocked()).toContain('your answer to "File the badge colour as a follow-up?" differs from the implemented choice');
    expect(button("Ship").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("what blocks Ship, per question (TP-3345, TP-3346)", { timeout: RENDER_TIMEOUT_MS }, () => {
  const submits = ({ calls }: Rendered) => calls.filter((call) => call.name === "rounds.submit").map((call) => call.args);
  const stake = (): HTMLElement => screen.getByTestId("ship-stake-badge-follow-up");
  const PROMPT = "File the badge colour as a follow-up?";

  async function implementedYes(): Promise<Partial<RoundDetail>> {
    const detail = await getRound(source, SHIP);
    if (!detail.valid) throw new Error("the Ship fixture is not a valid round");
    const questions = detail.manifest.questions.map((question) => (question.id === "badge-follow-up" && question.kind === "pick-one" ? { ...question, implemented: "Yes" } : question));
    return { manifest: { ...detail.manifest, questions } };
  }

  it("names the picks that block Ship and wake the fixer, and marks the answer as it is given", async () => {
    await renderShip({ answers: true, detail: await implementedYes() });

    expect(within(stake()).getByText('Picking "No", or leaving a comment, blocks Ship and sends the PR back to the fixer.')).toBeTruthy();
    fireEvent.click(getByRoleFast("radio", "2 No"));
    expect(within(stake()).getByText("Blocks Ship")).toBeTruthy();
    fireEvent.click(getByRoleFast("radio", "1 Yes"));
    expect(within(stake()).getByText("Won't block Ship")).toBeTruthy();
    expect(within(stake()).queryByText("Blocks Ship")).toBeNull();
  });

  it("calls an answer with nothing to match informational, until a comment makes it block", async () => {
    await renderShip({ answers: true });

    expect(within(stake()).getByText("Your answer is informational and never blocks Ship; only a comment does.")).toBeTruthy();
    fireEvent.click(getByRoleFast("radio", "2 No"));
    expect(within(stake()).getByText("Won't block Ship")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(`Comment on ${PROMPT}`), { target: { value: "Try the stripe's colour." } });
    expect(within(stake()).getByText("Blocks Ship")).toBeTruthy();
  });

  it("keeps This PR answers blocking as before, and ships a commented answer marked Follow-up with the mark", async () => {
    const rendered = await renderShip({ answers: true, detail: await implementedYes() });
    fireEvent.click(getByRoleFast("radio", "2 No"));
    fireEvent.change(screen.getByLabelText(`Comment on ${PROMPT}`), { target: { value: "Try the stripe's colour." } });
    expect(getByRoleFast("radio", "This PR", stake()).getAttribute("aria-checked")).toBe("true");
    expect(button("Ship").getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(getByRoleFast("radio", "Follow-up", stake()));

    expect(within(stake()).getAllByText("Follow-up")).toHaveLength(2);
    expect(within(stake()).getByText("Follow-up: never blocks Ship. Your answer is filed in the inbox as a follow-up when you send.")).toBeTruthy();
    expect(screen.queryByTestId("ship-blocked")).toBeNull();
    fireEvent.click(button("Ship"));
    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({
      headSha: HEAD,
      followUps: ["badge-follow-up"],
      answers: [{ questionId: "badge-follow-up", pick: "No", comment: "Try the stripe's colour." }, { questionId: "ship-tiles", pick: "Ship" }],
    });
  });

  it("sends no follow-up mark once the answer is switched back to This PR", async () => {
    const rendered = await renderShip({ answers: true });
    fireEvent.click(getByRoleFast("radio", "Follow-up", stake()));
    fireEvent.click(getByRoleFast("radio", "This PR", stake()));

    fireEvent.click(button("Ship"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).not.toHaveProperty("followUps");
  });

  it("shows a sent answer that went as a follow-up, without the choice", async () => {
    await renderShip({ answers: true, detail: { status: "sent", notes: { general: "", comments: {}, answers: {}, addressed: [] }, followUps: ["badge-follow-up"] } });

    expect(screen.getByTestId("ship-follow-up-sent-badge-follow-up").textContent).toContain("Marked follow-up, so it did not block Ship.");
    expect(screen.queryByTestId("ship-stake-badge-follow-up")).toBeNull();
  });
});

describe("a Ship round that shares the round answer state (TP-3766)", { timeout: RENDER_TIMEOUT_MS }, () => {
  const submits = ({ calls }: Rendered) => calls.filter((call) => call.name === "rounds.submit").map((call) => call.args);
  const follows = (earlier: HTMLElement, later: HTMLElement): boolean => (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  /** The Ship decision first, then an A/B over two of the round's frames and a text question. */
  async function shipFirst(): Promise<Partial<RoundDetail>> {
    const detail = await getRound(source, SHIP);
    if (!detail.valid) throw new Error("the Ship fixture is not a valid round");
    const ship = detail.manifest.questions.find((question) => question.id === "ship-tiles");
    if (ship === undefined) throw new Error("the Ship fixture has no ship-tiles question");
    const after: Question[] = [
      { id: "plane", kind: "pick-one", prompt: "Which tile reads better?", options: ["Light", "Dark"], optionVariants: { Light: "tile-light", Dark: "tile-dark" }, signsOff: "tile-plane" },
      { id: "notes", kind: "text", prompt: "Anything else?" },
    ];
    return { manifest: { ...detail.manifest, questions: [ship, ...after] } };
  }

  it("puts the Ship card after every question and sends an answer to a question that follows the Ship decision", async () => {
    const rendered = await renderShip({ answers: true, detail: await shipFirst() });

    expect(follows(screen.getByTestId("round-question-notes"), button("Ship"))).toBe(true);
    fireEvent.change(screen.getByLabelText("Answer to Anything else?"), { target: { value: "Looks fine." } });
    fireEvent.click(button("Ship"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({ answers: [{ questionId: "ship-tiles", pick: "Ship" }, { questionId: "notes", text: "Looks fine." }] });
  });

  it("locks the side questions once the answer is sent, showing the comment and follow-up mark as sent", async () => {
    await renderShip({ answers: true, detail: await shipFirst() });
    fireEvent.change(screen.getByLabelText("Answer to Anything else?"), { target: { value: "Looks fine." } });
    fireEvent.change(screen.getByLabelText("Comment on Anything else?"), { target: { value: "Recheck the stripe later." } });
    fireEvent.click(getByRoleFast("radio", "Follow-up", screen.getByTestId("ship-stake-notes")));
    fireEvent.click(button("Ship"));
    await screen.findByText("Waiting for the factory");

    const notes = screen.getByTestId("ship-side-notes");
    const answer = within(notes).getByLabelText<HTMLTextAreaElement>("Answer to Anything else?");
    expect(notes.hasAttribute("inert")).toBe(true);
    fireEvent.change(answer, { target: { value: "Changed my mind." } });
    expect(answer.value).toBe("Looks fine.");
    expect(within(notes).queryByLabelText("Comment on Anything else?")).toBeNull();
    expect(screen.getByTestId("round-comment-sent-notes").textContent).toContain("Recheck the stripe later.");
    expect(screen.getByTestId("ship-follow-up-sent-notes")).toBeTruthy();
    expect(screen.queryByTestId("ship-stake-notes")).toBeNull();
  });

  it("answers the active side question with its digit key", async () => {
    const rendered = await renderShip({ answers: true });

    fireEvent.keyDown(window, { key: "2" });
    expect(getByRoleFast("radio", "2 No").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(button("Ship"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({ answers: [{ questionId: "badge-follow-up", pick: "No" }, { questionId: "ship-tiles", pick: "Ship" }] });
  });

  it("lays a side question over two frames out as an A/B and sends its option notes", async () => {
    const rendered = await renderShip({ answers: true, detail: await shipFirst() });

    expect(screen.getByTestId("question-ab-plane")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("question-ab-side-plane-A")).getByText("1 Pick A"));
    fireEvent.change(screen.getByLabelText("Note on Dark"), { target: { value: " Too heavy. " } });
    fireEvent.click(button("Ship"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({ answers: [{ questionId: "ship-tiles" }, { questionId: "plane", pick: "Light", optionNotes: [{ option: "Dark", note: "Too heavy." }] }] });
  });
});

describe("a sent Ship round read back after a reload (TP-3767)", { timeout: RENDER_TIMEOUT_MS }, () => {
  const PRIOR = [{ round: 1, submittedAt: "2031-03-04T00:00:00.000Z", pick: "Don't ship", comment: "The stripe is two pixels low." }];
  const sent = {
    status: "sent" as const,
    priorFeedback: PRIOR,
    notes: { general: "", comments: { "badge-follow-up": "Ask design." }, answers: { "badge-follow-up": { pick: "No" }, "ship-tiles": { pick: "Ship" } }, addressed: [1] },
  };

  it("shows the side answer picked and locked, the Ship pick and the Addressed tick as sent", async () => {
    await renderShip({ answers: true, detail: sent });

    const side = screen.getByTestId("ship-side-badge-follow-up");
    expect(side.hasAttribute("inert")).toBe(true);
    expect(getByRoleFast("radio", "2 No", side).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("round-comment-sent-badge-follow-up").textContent).toContain("Ask design.");
    expect(screen.getByTestId("round-pick-sent-ship-tiles").textContent).toContain("Ship");
    const addressed = getByRoleFast("checkbox", "Round 1 feedback addressed", screen.getByTestId("ship-prior-feedback"));
    expect(addressed.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Ship" })).toBeNull();
  });

  it("takes no digit key or press on a side answer once sent", async () => {
    await renderShip({ answers: true, detail: sent });

    fireEvent.keyDown(window, { key: "1" });
    fireEvent.click(getByRoleFast("radio", "1 Yes", screen.getByTestId("ship-side-badge-follow-up")));

    expect(getByRoleFast("radio", "1 Yes").getAttribute("aria-checked")).toBe("false");
    expect(getByRoleFast("radio", "2 No").getAttribute("aria-checked")).toBe("true");
  });
});

describe("frame feedback on a Ship round (TP-3773 S6b)", { timeout: RENDER_TIMEOUT_MS }, () => {
  const submits = ({ calls }: Rendered) => calls.filter((call) => call.name === "rounds.submit").map((call) => call.args);
  const verdict = (key: string, label: string): HTMLElement => (openDiff(), getButton(label, screen.getByTestId(`montage-${key}`)));
  const blocked = (): string => screen.getByTestId("ship-blocked").textContent;

  it("turns Ship off for a Rejected frame, and sends its verdict and comment with Send back", async () => {
    const rendered = await renderShip({ answers: true });

    fireEvent.click(verdict("tile-dark", "Rejected"));
    expect(blocked()).toContain('you left feedback on frame "Tile, dark"');
    expect(button("Ship").getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(screen.getByLabelText("Comment on frame Tile, dark"), { target: { value: " The stripe clips. " } });
    fireEvent.click(button("Send back"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({ variants: [{ key: "tile-dark", verdict: "rejected", comment: "The stripe clips." }], answers: [{ questionId: "ship-tiles", pick: "Don't ship" }] });
  });

  it("ships with a Chosen frame that has no comment, and sends the verdict", async () => {
    const rendered = await renderShip({ answers: true });

    fireEvent.click(verdict("tile-light", "Chosen"));
    expect(screen.queryByTestId("ship-blocked")).toBeNull();
    fireEvent.click(button("Ship"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({ headSha: HEAD, variants: [{ key: "tile-light", verdict: "chosen" }] });
  });

  it("lets a frame comment alone be the Send back note", async () => {
    await renderShip({ answers: true });
    expect(button("Send back").getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(screen.getByLabelText("Comment on frame Badge (new)"), { target: { value: "Badge is off-centre." } });

    expect(screen.queryByTestId("send-back-blocked")).toBeNull();
    expect(button("Send back").getAttribute("aria-disabled")).not.toBe("true");
  });

  it("lists an earlier round's frame feedback and holds Ship until it is ticked Addressed", async () => {
    const priorFeedback = [{ round: 1, submittedAt: "2031-03-04T00:00:00.000Z", frames: ["Tile, dark (rejected): The stripe clips."] }];
    await renderShip({ answers: true, detail: { priorFeedback } });

    expect(within(screen.getByTestId("ship-prior-feedback")).getByText("Tile, dark (rejected): The stripe clips.")).toBeTruthy();
    expect(blocked()).toContain("your feedback from round 1 is not ticked Addressed");
    fireEvent.click(getByRoleFast("checkbox", "Round 1 feedback addressed"));
    expect(screen.queryByTestId("ship-blocked")).toBeNull();
  });

  it("shows a sent round's frame verdict and comment read-only", async () => {
    const frames = { "tile-dark": { verdict: "rejected" as const, comment: "The stripe clips.", annotations: [] } };
    await renderShip({ answers: true, detail: { status: "sent", notes: { general: "", comments: {}, answers: {}, addressed: [], frames } } });

    expect(screen.getByTestId("frame-feedback-sent-tile-dark").textContent).toBe("RejectedThe stripe clips.");
    expect(screen.queryByRole("button", { name: "Rejected" })).toBeNull();
    expect(screen.queryByLabelText("Comment on frame Tile, dark")).toBeNull();
  });
});

describe("an unsent Ship round's draft (TP-3870)", { timeout: RENDER_TIMEOUT_MS }, () => {
  const submits = ({ calls }: Rendered) => calls.filter((call) => call.name === "rounds.submit").map((call) => call.args);
  const PRIOR = [{ round: 1, submittedAt: "2031-03-04T00:00:00.000Z", pick: "Don't ship", comment: "The stripe is two pixels low." }];
  const SIDE_COMMENT = "Comment on File the badge colour as a follow-up?";
  const stored = (): string | null => localStorage.getItem(draftKey(SHIP));
  const addressedTick = (): HTMLElement => getByRoleFast("checkbox", "Round 1 feedback addressed");
  const value = (label: string): string => screen.getByLabelText<HTMLTextAreaElement>(label).value;

  /** Answers and comments on the side question, ticks round 1 Addressed and writes the Send back note, then waits for the write. */
  async function typeDraft(): Promise<void> {
    fireEvent.click(getByRoleFast("radio", "2 No"));
    fireEvent.change(screen.getByLabelText(SIDE_COMMENT), { target: { value: "Ask design first." } });
    fireEvent.click(addressedTick());
    fireEvent.change(screen.getByLabelText("Note for Send back"), { target: { value: "Lift the stripe." } });
    await waitFor(() => expect(stored()).toContain("Lift the stripe."));
  }

  it("restores the side answer and comment, the Addressed tick and the Send back note after a remount", async () => {
    await renderShip({ answers: true, detail: { priorFeedback: PRIOR } });
    await typeDraft();
    cleanup();

    await renderShip({ answers: true, detail: { priorFeedback: PRIOR } });

    expect(getByRoleFast("radio", "2 No").getAttribute("aria-checked")).toBe("true");
    expect(value(SIDE_COMMENT)).toBe("Ask design first.");
    expect(addressedTick().getAttribute("aria-checked")).toBe("true");
    expect(value("Note for Send back")).toBe("Lift the stripe.");
    expect(screen.queryByText("Draft from an older version discarded")).toBeNull();
  });

  it("is discarded, with a note, when the round's manifest sha has changed", async () => {
    await renderShip({ answers: true, detail: { priorFeedback: PRIOR, manifestSha256: "a".repeat(64) } });
    await typeDraft();
    cleanup();

    await renderShip({ answers: true, detail: { priorFeedback: PRIOR } });

    expect(screen.getByText("Draft from an older version discarded")).toBeTruthy();
    expect(addressedTick().getAttribute("aria-checked")).toBe("false");
    expect(value("Note for Send back")).toBe("");
    expect(stored()).toBeNull();
  });

  it("is cleared by Send back, and nothing is restored after it", async () => {
    const rendered = await renderShip({ answers: true, detail: { priorFeedback: PRIOR } });
    await typeDraft();

    fireEvent.click(button("Send back"));
    await waitFor(() => expect(submits(rendered)).toHaveLength(1));

    await waitFor(() => expect(stored()).toBeNull());
    cleanup();
    expect(stored()).toBeNull();
  });

  it("is never restored into a round already sent, and is dropped", async () => {
    await renderShip({ answers: true, detail: { priorFeedback: PRIOR } });
    await typeDraft();
    cleanup();

    await renderShip({ answers: true, detail: { status: "sent", priorFeedback: PRIOR, notes: { general: "", comments: {}, answers: { "ship-tiles": { pick: "Ship" } }, addressed: [] } } });

    expect(screen.queryByLabelText("Note for Send back")).toBeNull();
    expect(screen.queryByText("Ask design first.")).toBeNull();
    expect(addressedTick().getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(stored()).toBeNull());
  });
});
