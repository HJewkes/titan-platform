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
import { AnswerSourceProvider } from "./data/submit.js";

const SHIP = "ship-tile-r1";
const HEAD = "89abcdef0123456789abcdef0123456789abcdef";
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
  const counting: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, callOptions) => (calls.push({ name, args }), name === "rounds.submit" ? Promise.resolve(submitted) : inner.call(name, args, callOptions)),
  };
  window.location.hash = `#/rounds/${SHIP}`;
  render(
    <RpcProvider source={counting}>
      <AnswerSourceProvider value={options.answers ? counting : null}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  await screen.findByTestId("montage-tile-light");
  return { calls };
}

const panelLabels = (key: string): string[] => within(screen.getByTestId(`montage-${key}`)).getAllByText(/^(BEFORE \(main\)|AFTER \(head\)|DIFF)$/).map((label) => label.textContent);
const button = (label: string): HTMLElement => screen.getByRole("button", { name: label });
const frameCalls = ({ calls }: Rendered) => calls.filter((call) => call.name === "rounds.frame");

describe("the Ship view", () => {
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
    expect(within(screen.getByTestId("montage-panel-wide")).getByText("No diff image: compare before and after side by side.")).toBeTruthy();
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

    scrollAll();

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(IMAGE_COUNT));
    expect(frameCalls(rendered)).toHaveLength(IMAGE_COUNT);
    expect(frameCalls(rendered)).toContainEqual({ name: "rounds.frame", args: { id: SHIP, key: "tile-dark", view: "diff" } });
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
    scrollAll();

    fireEvent.click(await screen.findByRole("button", { name: "Enlarge Badge (new), after" }));
    expect(screen.getByRole("dialog", { name: "Badge (new), after" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("answering a Ship round", () => {
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
    const notes = { general: "The diffs made this easy.", comments: { "badge-follow-up": "Only if design agrees.", "ship-tiles": "Stripe is low." } };
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

describe("answering a Ship round with side questions", () => {
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

    fireEvent.click(screen.getByRole("radio", { name: "1 Yes" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "1 Light" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "3 Wide" }));
    fireEvent.click(screen.getByRole("radio", { name: "4 4" }));
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

    fireEvent.click(screen.getByRole("radio", { name: "2 No" }));
    fireEvent.click(button("Send back"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({ answers: [{ questionId: "side-colour", pick: "No" }, { questionId: "ship-tiles", pick: "Don't ship" }] });
  });

  it("blocks both answers with an inline message while a required side question is empty", async () => {
    const rendered = await renderShip({ answers: true, detail: await td850(true) });

    expect(screen.getByText("Answer the required question first: How clear is the stripe?")).toBeTruthy();
    fireEvent.click(button("Ship"));
    expect(submits(rendered)).toHaveLength(0);

    fireEvent.click(screen.getByRole("radio", { name: "2 2" }));
    expect(screen.queryByText(/Answer the required question first/)).toBeNull();
    fireEvent.click(button("Ship"));
    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
  });

  it("no longer calls the side questions read-only", async () => {
    await renderShip({ answers: true, detail: await td850() });

    expect(screen.queryByText(/not sent/)).toBeNull();
  });
});

describe("Ship while feedback is open (TP-3741)", () => {
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
    expect(button("Send back").getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(button("Ship"));
    expect(submits(rendered)).toHaveLength(0);

    fireEvent.click(screen.getByRole("checkbox", { name: "Round 1 feedback addressed" }));
    expect(screen.queryByTestId("ship-blocked")).toBeNull();
    fireEvent.click(button("Ship"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).toMatchObject({ addressed: [1], headSha: HEAD, answers: [{ questionId: "ship-tiles", pick: "Ship" }] });
  });

  it("turns Ship off while a comment is typed, and back on once it is cleared", async () => {
    await renderShip({ answers: true });
    const comment = screen.getByLabelText("Comment on File the badge colour as a follow-up?");

    fireEvent.change(comment, { target: { value: "Only if design agrees." } });
    expect(blocked()).toContain('Ship is off: you left a comment on "File the badge colour as a follow-up?". Send back stays open.');
    expect(button("Ship").getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(comment, { target: { value: "" } });
    expect(screen.queryByTestId("ship-blocked")).toBeNull();
  });

  it("turns Ship off for a side pick that differs from the implemented choice", async () => {
    const detail = await getRound(source, SHIP);
    if (!detail.valid) throw new Error("the Ship fixture is not a valid round");
    const questions = detail.manifest.questions.map((question) => (question.id === "badge-follow-up" && question.kind === "pick-one" ? { ...question, implemented: "Yes" } : question));
    await renderShip({ answers: true, detail: { manifest: { ...detail.manifest, questions } } });

    fireEvent.click(screen.getByRole("radio", { name: "2 No" }));

    expect(blocked()).toContain('your answer to "File the badge colour as a follow-up?" differs from the implemented choice');
    expect(button("Ship").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("what blocks Ship, per question (TP-3345, TP-3346)", () => {
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
    fireEvent.click(screen.getByRole("radio", { name: "2 No" }));
    expect(within(stake()).getByText("Blocks Ship")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "1 Yes" }));
    expect(within(stake()).getByText("Won't block Ship")).toBeTruthy();
    expect(within(stake()).queryByText("Blocks Ship")).toBeNull();
  });

  it("calls an answer with nothing to match informational, until a comment makes it block", async () => {
    await renderShip({ answers: true });

    expect(within(stake()).getByText("Your answer is informational and never blocks Ship; only a comment does.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "2 No" }));
    expect(within(stake()).getByText("Won't block Ship")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(`Comment on ${PROMPT}`), { target: { value: "Try the stripe's colour." } });
    expect(within(stake()).getByText("Blocks Ship")).toBeTruthy();
  });

  it("keeps This PR answers blocking as before, and ships a commented answer marked Follow-up with the mark", async () => {
    const rendered = await renderShip({ answers: true, detail: await implementedYes() });
    fireEvent.click(screen.getByRole("radio", { name: "2 No" }));
    fireEvent.change(screen.getByLabelText(`Comment on ${PROMPT}`), { target: { value: "Try the stripe's colour." } });
    expect(within(stake()).getByRole("radio", { name: "This PR" }).getAttribute("aria-checked")).toBe("true");
    expect(button("Ship").getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(within(stake()).getByRole("radio", { name: "Follow-up" }));

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
    fireEvent.click(within(stake()).getByRole("radio", { name: "Follow-up" }));
    fireEvent.click(within(stake()).getByRole("radio", { name: "This PR" }));

    fireEvent.click(button("Ship"));

    await waitFor(() => expect(submits(rendered)).toHaveLength(1));
    expect(submits(rendered)[0]).not.toHaveProperty("followUps");
  });

  it("shows a sent answer that went as a follow-up, without the choice", async () => {
    await renderShip({ answers: true, detail: { status: "sent", notes: { general: "", comments: {} }, followUps: ["badge-follow-up"] } });

    expect(screen.getByTestId("ship-follow-up-sent-badge-follow-up").textContent).toContain("Marked follow-up, so it did not block Ship.");
    expect(screen.queryByTestId("ship-stake-badge-follow-up")).toBeNull();
  });
});
