// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS as source, sentRound } from "../server/round-fixtures.js";
import { getFrame, listFrames } from "../server/round-frames.js";
import type { Question } from "../server/round-schema.js";
import { getRound, type RoundDetail, type RoundsSource } from "../server/rounds.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";
import { checkAndSend, checkButton, toSection } from "./pages/round-pager.test-helpers.js";

const DESIGN = "beacon-states-r1";
const STATES = [
  ["beacon-idle", "Idle"],
  ["beacon-busy", "Busy"],
  ["beacon-error", "Error"],
  ["beacon-muted", "Muted"],
] as const;

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

type Listing = Snapshot["calls"][string];

/** The daemon's answers over the synthetic design fixture; `detail` overrides rounds.get, `listing` replaces rounds.frames, `rounds` is where rounds.get reads. */
async function recorded(detail: Partial<RoundDetail>, listing?: Listing, rounds: RoundsSource = source, extra: Snapshot["calls"] = {}): Promise<Snapshot> {
  const frames = await Promise.all(
    STATES.map(async ([key]) => [snapshotKey("rounds.frame", { id: DESIGN, key, view: "head" }), successEnvelope(await getFrame(source, DESIGN, key, "head"))] as const),
  );
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: {
      [snapshotKey("rounds.get", { id: DESIGN })]: successEnvelope({ ...(await getRound(rounds, DESIGN)), ...detail }),
      [snapshotKey("rounds.frames", { id: DESIGN })]: listing ?? successEnvelope(await listFrames(source, DESIGN)),
      ...Object.fromEntries(frames),
      ...extra,
    },
  };
}

interface Rendered {
  calls: { name: string; args: unknown }[];
}

/** Renders the design round over a recorded snapshot; rounds.submit answers "submitted". */
async function renderDesign(options: { detail?: Partial<RoundDetail>; listing?: Listing; rounds?: RoundsSource; extra?: Snapshot["calls"] } = {}): Promise<Rendered> {
  const snapshot = await recorded(options.detail ?? {}, options.listing, options.rounds, options.extra);
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  const inner = pageDataSource({ doc: page });
  const calls: Rendered["calls"] = [];
  const submitted = successEnvelope({ status: "submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: null });
  const counting: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, callOptions) => (calls.push({ name, args }), name === "rounds.submit" ? Promise.resolve(submitted) : inner.call(name, args, callOptions)),
  };
  window.location.hash = `#/rounds/${DESIGN}`;
  render(
    <RpcProvider source={counting}>
      <AnswerSourceProvider value={counting}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  await screen.findByText("Beacon states");
  return { calls };
}

const keyOf = (args: unknown): unknown => (typeof args === "object" && args !== null && "key" in args ? args.key : undefined);
const frameKeys = ({ calls }: Rendered): unknown[] => calls.filter((call) => call.name === "rounds.frame").map((call) => keyOf(call.args));

async function designRound(): Promise<Extract<RoundDetail, { valid: true }>> {
  const round = await getRound(source, DESIGN);
  if (!round.valid) throw new Error(round.reason);
  return round;
}

describe("a design round", () => {
  it("renders every STATES variant as a labelled frame that opens full size", async () => {
    await renderDesign();
    scrollAll();

    for (const [key, label] of STATES) {
      const figure = screen.getByTestId(`design-frame-${key}`);
      expect(within(figure).getByText(label)).toBeTruthy();
      expect(await within(figure).findByRole("img", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Enlarge Busy" }));
    expect(screen.getByRole("dialog", { name: "Busy" })).toBeTruthy();
    expect(screen.queryByText("design round: open in the harness")).toBeNull();
  });

  it("shows a section's seeAlso frames as labelled thumbnails", async () => {
    await renderDesign();
    await toSection("fill");
    scrollAll();

    for (const [key, label] of [["beacon-idle", "Idle"], ["beacon-error", "Error"]]) {
      expect(await within(screen.getByTestId(`see-also-${key}`)).findByRole("img", { name: label })).toBeTruthy();
    }
    expect(screen.queryByTestId("see-also-beacon-busy")).toBeNull();
  });

  it("names a section key frames.json does not list and never asks for it", async () => {
    const rendered = await renderDesign();
    scrollAll();
    await screen.findAllByRole("img", { name: "Idle" });
    await toSection("sketch");
    scrollAll();

    expect(within(screen.getByTestId("design-frame-beacon-sketch")).getByText("Not in frames.json")).toBeTruthy();
    expect(frameKeys(rendered)).not.toContain("beacon-sketch");
  });

  it("sends the picks and text with the round.json shown", async () => {
    const { calls } = await renderDesign();
    await toSection("fill");
    fireEvent.keyDown(window, { key: "2" });
    await toSection("sketch");
    fireEvent.change(screen.getByLabelText("Answer to Anything from the sketch worth keeping?"), { target: { value: "Keep the halo." } });
    checkAndSend();

    await screen.findByText("Answers sent");
    const { manifestSha256 } = await designRound();
    expect(calls.find((call) => call.name === "rounds.submit")?.args).toEqual({
      id: DESIGN,
      manifestSha256,
      general: "",
      answers: [{ questionId: "beacon-fill-pick", pick: "Ring" }, { questionId: "beacon-notes", text: "Keep the halo." }],
      variants: [],
    });
  });

  it("offers a comment on each question and feedback on the round, and sends them", async () => {
    const { calls } = await renderDesign();

    await toSection("fill");
    fireEvent.keyDown(window, { key: "1" });
    fireEvent.change(screen.getByLabelText("Comment on Should the beacon be filled or a ring?"), { target: { value: "Filled, but thinner." } });
    await toSection("sketch");
    fireEvent.change(screen.getByLabelText("Comment on Anything from the sketch worth keeping?"), { target: { value: "Nothing yet." } });
    fireEvent.change(screen.getByLabelText("Feedback on this round"), { target: { value: "Frames load fast." } });
    checkAndSend();

    await screen.findByText("Answers sent");
    expect(calls.find((call) => call.name === "rounds.submit")?.args).toMatchObject({
      general: "Frames load fast.",
      answers: [{ questionId: "beacon-fill-pick", pick: "Filled", comment: "Filled, but thinner." }, { questionId: "beacon-notes", comment: "Nothing yet." }],
    });
  });

  it("shows a sent design round's pick and text answer locked after a reload (TP-3767)", async () => {
    const answers = { "beacon-fill-pick": { pick: "Ring" }, "beacon-notes": { text: "Keep the idle glow." } };
    await renderDesign({ detail: { status: "sent", notes: { general: "", comments: {}, answers, addressed: [] } } });

    await toSection("fill");
    const pick = screen.getByTestId("round-entry-beacon-fill-pick");
    expect(pick.hasAttribute("inert")).toBe(true);
    expect(within(pick).getByText(/Ring/).closest('[role="radio"]')?.getAttribute("aria-checked")).toBe("true");
    await toSection("sketch");
    expect(screen.getByLabelText<HTMLTextAreaElement>(/^Answer to /).value).toBe("Keep the idle glow.");
    expect(screen.getByTestId("round-entry-beacon-notes").hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("button", { name: "Check and send" })).toBeNull();
  });

  it("shows a sent design round's comments and round feedback read-only", async () => {
    await renderDesign({ detail: { status: "sent", notes: { general: "Frames load fast.", comments: { "beacon-fill-pick": "Filled, but thinner." }, answers: {}, addressed: [] } } });

    await toSection("fill");
    expect(screen.getByTestId("round-comment-sent-beacon-fill-pick").textContent).toContain("Filled, but thinner.");
    await toSection("sketch");
    expect(screen.getByTestId("round-general-sent").textContent).toContain("Frames load fast.");
    expect(screen.queryByLabelText("Comment on Anything from the sketch worth keeping?")).toBeNull();
  });

  it("keeps an after-answer round's recommendation out until the round is sent", async () => {
    await renderDesign();
    expect(screen.queryByText(/^Recommended:/)).toBeNull();
    expect(screen.getByText("Recommendations are hidden until you answer; reveal one first with r.")).toBeTruthy();
    cleanup();

    const { manifest } = await designRound();
    const recommendation = { answer: "Filled", rationale: "A filled dot reads at a glance on a phone.", confidence: 0.8, by: "fixture-agent" };
    const questions = manifest.questions.map((each) => (each.id === "beacon-fill-pick" ? { ...each, recommendation } : each));
    await renderDesign({ detail: { status: "sent", recommendationsWithheld: false, manifest: { ...manifest, questions } } });

    await toSection("fill");
    expect(screen.getByText("Recommended: Filled (80%, fixture-agent)")).toBeTruthy();
    await toSection("sketch");
    expect(screen.getByText("Answers sent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check and send" })).toBeNull();
  });
});

const verdictButton = (key: string, verdict: string): HTMLElement => within(screen.getByTestId(`frame-feedback-${key}`)).getByRole("button", { name: verdict });
const pressed = (key: string, verdict: string): string | null => verdictButton(key, verdict).closest("[aria-pressed]")?.getAttribute("aria-pressed") ?? null;
const pressedVerdicts = (key: string): string[] => ["Chosen", "Rejected", "Maybe"].filter((verdict) => pressed(key, verdict) === "true");
const pickOf = (option: string): string | null | undefined => within(screen.getByTestId("round-question-beacon-fill-pick")).getByText(new RegExp(option)).closest('[role="radio"]')?.getAttribute("aria-checked");
/** An inactive frame keeps its key hint's line, hidden, so activating another frame moves nothing under the pointer. */
const keyHint = (key: string): string => {
  const hint = within(screen.getByTestId(`frame-feedback-${key}`)).getByText("c chosen · x rejected · m maybe · u clear · a pin").closest("[aria-hidden]");
  return hint?.getAttribute("aria-hidden") === "false" ? "shown" : hint?.classList.contains("invisible") ? "hidden in place" : "missing";
};
const submitted = ({ calls }: Rendered): unknown => calls.find((call) => call.name === "rounds.submit")?.args;

async function send(rendered: Rendered): Promise<unknown> {
  checkAndSend();
  await screen.findByText("Answers sent");
  return submitted(rendered);
}

/** The round with Muted drawn above the pick question, so one page holds a frame and a question with choices. */
async function withMutedAnchored(): Promise<Partial<RoundDetail>> {
  const { manifest } = await designRound();
  const questions = manifest.questions.map((each) => (each.id === "beacon-fill-pick" ? { ...each, frames: ["beacon-muted"] } : each));
  return { manifest: { ...manifest, questions } };
}

/** Answers the required pick on its page, then sends from the last page. */
async function answerAndSend(rendered: Rendered): Promise<unknown> {
  await toSection("fill");
  fireEvent.keyDown(window, { key: "1" });
  await toSection("sketch");
  return send(rendered);
}

describe("a design round's frame verdicts and comments (TP-3773)", () => {
  it("sends a pressed verdict and a typed comment as the frame's variant, kept across pages", async () => {
    const rendered = await renderDesign();

    fireEvent.click(verdictButton("beacon-busy", "Rejected"));
    fireEvent.change(screen.getByLabelText("Comment on frame Busy"), { target: { value: "Busy reads as idle. " } });

    expect(await answerAndSend(rendered)).toMatchObject({ variants: [{ key: "beacon-busy", verdict: "rejected", comment: "Busy reads as idle." }] });
  });

  it("clears a verdict pressed a second time, and sends no variant for it", async () => {
    const rendered = await renderDesign();

    fireEvent.click(verdictButton("beacon-idle", "Chosen"));
    fireEvent.click(verdictButton("beacon-idle", "Chosen"));

    expect(pressedVerdicts("beacon-idle")).toEqual([]);
    expect(await answerAndSend(rendered)).toMatchObject({ variants: [] });
  });

  it("judges the active frame with letter keys, and leaves digits to the questions", async () => {
    await renderDesign({ detail: await withMutedAnchored() });
    await toSection("fill");
    fireEvent.pointerDown(screen.getByTestId("frame-feedback-beacon-muted"));

    fireEvent.keyDown(window, { key: "x" });
    fireEvent.keyDown(window, { key: "2" });

    expect(pressedVerdicts("beacon-muted")).toEqual(["Rejected"]);
    expect(pickOf("Ring")).toBe("false");
    expect(keyHint("beacon-muted")).toBe("shown");
    fireEvent.keyDown(window, { key: "m" });
    expect(pressedVerdicts("beacon-muted")).toEqual(["Maybe"]);
    fireEvent.keyDown(window, { key: "u" });
    expect(pressedVerdicts("beacon-muted")).toEqual([]);
  });

  it("keeps an inactive frame's key hint in place, hidden", async () => {
    await renderDesign();
    fireEvent.pointerDown(screen.getByTestId("design-frame-beacon-error"));

    expect(keyHint("beacon-error")).toBe("shown");
    expect(keyHint("beacon-idle")).toBe("hidden in place");
  });

  it("leaves letter keys alone while a question is active, which digits answer", async () => {
    const rendered = await renderDesign({ detail: await withMutedAnchored() });
    await toSection("fill");

    const passedOn = fireEvent.keyDown(window, { key: "x" });
    fireEvent.keyDown(window, { key: "2" });

    expect(passedOn).toBe(true);
    expect(pickOf("Ring")).toBe("true");
    expect(pressedVerdicts("beacon-muted")).toEqual([]);
    await toSection("sketch");
    expect(await send(rendered)).toMatchObject({ answers: [{ questionId: "beacon-fill-pick", pick: "Ring" }], variants: [] });
  });

  it("hands the keys back to the page's question when the page turns away from an active frame", async () => {
    await renderDesign({ detail: await withMutedAnchored() });
    await toSection("fill");
    fireEvent.pointerDown(screen.getByTestId("frame-feedback-beacon-muted"));

    await toSection("states");
    await toSection("fill");
    fireEvent.keyDown(window, { key: "x" });
    fireEvent.keyDown(window, { key: "2" });

    expect(pressedVerdicts("beacon-muted")).toEqual([]);
    expect(pickOf("Ring")).toBe("true");
  });

  it("judges a frame a question draws above itself, which stays the active one after the press", async () => {
    const rendered = await renderDesign({ detail: await withMutedAnchored() });
    await toSection("fill");
    fireEvent.keyDown(window, { key: "1" });

    const frame = screen.getByTestId("frame-feedback-beacon-muted");
    fireEvent.pointerDown(frame);
    fireEvent.click(frame);
    fireEvent.keyDown(window, { key: "c" });

    expect(pressedVerdicts("beacon-muted")).toEqual(["Chosen"]);
    await toSection("states");
    expect(screen.queryByTestId("design-frame-beacon-muted")).toBeNull();
    await toSection("sketch");
    expect(await send(rendered)).toMatchObject({ variants: [{ key: "beacon-muted", verdict: "chosen" }] });
  });

  it("takes no more letter keys once the round is sent, so the frame shows the verdict it was sent with", async () => {
    const rendered = await renderDesign();
    await toSection("fill");
    fireEvent.keyDown(window, { key: "1" });
    await toSection("sketch");
    fireEvent.pointerDown(screen.getByTestId("design-frame-beacon-sketch"));
    fireEvent.keyDown(window, { key: "m" });

    expect(await send(rendered)).toMatchObject({ variants: [{ key: "beacon-sketch", verdict: "maybe" }] });
    const passedOn = fireEvent.keyDown(window, { key: "x" });
    fireEvent.keyDown(window, { key: "u" });

    expect(passedOn).toBe(true);
    expect(screen.getByTestId("frame-feedback-sent-beacon-sketch").textContent).toBe("Maybe");
  });

  it("shows a sent round's frame verdict, comment and pin read-only after a reload", async () => {
    const echo = { verdict: null, comment: "", annotations: [] };
    const pin = { id: "beacon-error-1", width: 375, x: 90, y: 30, xPct: 0.25, yPct: 0.5, target: { testId: "beacon-dot" }, note: "Too red." };
    const variants = [
      { key: "beacon-busy", ...echo, verdict: "rejected", comment: "Busy reads as idle.\nTry a pulse." },
      { key: "beacon-error", ...echo, annotations: [pin] },
      { key: "beacon-idle", ...echo },
    ];
    const feedback = { schema: "titan-review/feedback@1", unit: "beacon-states", round: 1, manifestSha256: "0".repeat(64), submittedAt: "2031-03-02T10:00:00.000Z", answers: [], variants, general: "" };
    const staged = await sentRound(DESIGN, feedback);
    onTestFinished(staged.remove);
    await renderDesign({ rounds: staged.source });

    const busy = within(screen.getByTestId("design-frame-beacon-busy"));
    expect(busy.getByText("Rejected")).toBeTruthy();
    expect(busy.getByText("Busy reads as idle.\nTry a pulse.", { normalizer: (text) => text })).toBeTruthy();
    expect(within(screen.getByTestId("design-frame-beacon-error")).getByText("Pin 1 at 25%, 50% on #beacon-dot: Too red.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rejected" })).toBeNull();
    expect(screen.queryByLabelText("Comment on frame Busy")).toBeNull();
    expect(screen.queryByTestId("frame-feedback-sent-beacon-idle")).toBeNull();
    fireEvent.pointerDown(screen.getByTestId("design-frame-beacon-busy"));
    fireEvent.keyDown(window, { key: "c" });
    expect(busy.queryByText("Chosen")).toBeNull();
  });

  it("gives see-also thumbnails no verdict of their own", async () => {
    await renderDesign();
    await toSection("fill");

    expect(within(screen.getByTestId("see-also-beacon-idle")).queryByRole("button", { name: "Chosen" })).toBeNull();
  });
});

describe("a design round the console cannot show", () => {
  it.each([
    ["has no frames.json", successEnvelope({ indexed: false, frames: [] })],
    ["has an invalid frames.json", errorEnvelope("frame refused: the round's frames index is not a frames@1 index", 66)],
  ])("falls back to the harness notice when it %s", async (_label, listing) => {
    const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", await recorded({}, listing)), "text/html");
    window.location.hash = `#/rounds/${DESIGN}`;
    render(
      <RpcProvider source={pageDataSource({ doc: page })}>
        <App />
      </RpcProvider>,
    );

    await waitFor(() => expect(screen.getByText("design round: open in the harness")).toBeTruthy());
    expect(screen.queryByTestId("round-question-beacon-fill-pick")).toBeNull();
    expect(screen.queryByTestId("design-frame-beacon-idle")).toBeNull();
  });
});

describe("a design round's check before sending (TP-3775)", () => {
  it("lists each judged frame under its section with its verdict and comment, beside the answers", async () => {
    await renderDesign();
    fireEvent.click(verdictButton("beacon-busy", "Rejected"));
    fireEvent.change(screen.getByLabelText("Comment on frame Busy"), { target: { value: "Busy reads as idle." } });
    await toSection("fill");
    fireEvent.keyDown(window, { key: "2" });
    await toSection("sketch");

    fireEvent.click(checkButton());

    const frame = within(screen.getByTestId("round-check-section-states")).getByTestId("round-check-frame-beacon-busy");
    expect(within(frame).getByText("Frame Busy")).toBeTruthy();
    expect(within(frame).getByText("rejected")).toBeTruthy();
    expect(within(frame).getByText("Busy reads as idle.")).toBeTruthy();
    expect(screen.queryByTestId("round-check-frame-beacon-idle")).toBeNull();
    expect(within(screen.getByTestId("round-check-answer-beacon-fill-pick")).getByText("Ring")).toBeTruthy();
    expect(screen.getByTestId("round-check-send").textContent).toBe("Send partial: 1 unanswered");
  });

  it("takes no frame letter keys while it is open", async () => {
    const rendered = await renderDesign();
    await toSection("sketch");
    fireEvent.pointerDown(screen.getByTestId("frame-feedback-beacon-sketch"));
    fireEvent.keyDown(window, { key: "c" });
    expect(pressedVerdicts("beacon-sketch")).toEqual(["Chosen"]);
    fireEvent.click(checkButton());

    fireEvent.keyDown(window, { key: "x" });
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });

    await screen.findByText("Answers sent");
    expect(submitted(rendered)).toMatchObject({ variants: [{ key: "beacon-sketch", verdict: "chosen" }] });
  });
});

/** jsdom lays nothing out: every image is a 750x1334 PNG drawn 187.5 px wide at the page's top left. */
function layOut(): void {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(750);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(1334);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 187.5, height: 333.5, right: 187.5, bottom: 333.5, x: 0, y: 0, toJSON: () => ({}) });
}

/** A phone: `(pointer: coarse)` matches. */
function onPhone(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

const pinButton = (key: string): HTMLElement => within(screen.getByTestId(`frame-feedback-${key}`)).getByRole("button", { name: /^Pin / });

/** A press on a frame's pin layer that lifts `moved` px from where it went down. */
function tap(layer: HTMLElement, clientX: number, clientY: number, moved = 0): void {
  fireEvent.pointerDown(layer, { clientX, clientY });
  fireEvent.pointerUp(layer, { clientX: clientX + moved, clientY });
}

async function pinMode(key: string): Promise<HTMLElement> {
  scrollAll();
  await within(screen.getByTestId(`design-frame-${key}`)).findByRole("img");
  fireEvent.pointerDown(screen.getByTestId(`design-frame-${key}`));
  fireEvent.click(pinButton(key));
  return screen.getByTestId(`pin-layer-${key}`);
}

describe("a design round's frame pins (TP-3773 S4)", () => {
  beforeEach(layOut);
  afterEach(() => vi.restoreAllMocks());

  it("places a numbered pin where a click lands in pin mode, measured in frames.json's viewport width, focuses its note and sends it", async () => {
    const rendered = await renderDesign();
    const layer = await pinMode("beacon-busy");

    tap(layer, 100, 50);

    expect(within(screen.getByTestId("design-frame-beacon-busy")).getByTestId("pin-marker-beacon-busy-1").textContent).toBe("1");
    const note = screen.getByLabelText("Note for pin 1");
    expect(document.activeElement).toBe(note);
    fireEvent.change(note, { target: { value: "Spinner sits off centre." } });
    expect(await answerAndSend(rendered)).toMatchObject({
      variants: [{ key: "beacon-busy", annotations: [{ id: "beacon-busy-1", width: 320, x: 171, y: 85, xPct: 0.5344, yPct: 0.1493, note: "Spinner sits off centre." }] }],
    });
  });

  it("places nothing for a press that moved 20 px, which was a scroll", async () => {
    await renderDesign();
    const layer = await pinMode("beacon-busy");

    tap(layer, 100, 50, 20);

    expect(screen.queryByTestId("pin-marker-beacon-busy-1")).toBeNull();
  });

  it("toggles pin mode with a on the active frame, leaves it with Escape, and enlarges on a tap outside it", async () => {
    await renderDesign();
    scrollAll();
    await within(screen.getByTestId("design-frame-beacon-idle")).findByRole("img");
    fireEvent.pointerDown(screen.getByTestId("design-frame-beacon-idle"));

    fireEvent.keyDown(window, { key: "a" });
    expect(screen.getByTestId("pin-layer-beacon-idle")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("pin-layer-beacon-idle")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enlarge Idle" }));
    expect(screen.getByRole("dialog", { name: "Idle" })).toBeTruthy();
  });

  it("numbers a pin placed after a removal past every number handed out", async () => {
    await renderDesign();
    const layer = await pinMode("beacon-busy");
    tap(layer, 10, 10);
    tap(layer, 20, 20);

    fireEvent.click(screen.getByRole("button", { name: "Remove pin 2" }));
    tap(layer, 30, 30);

    expect(screen.queryByLabelText("Note for pin 2")).toBeNull();
    expect(screen.getByLabelText("Note for pin 3")).toBeTruthy();
  });

  it("opens the full-size view on a phone instead of pinning the small strip frame, and pins there", async () => {
    onPhone();
    await renderDesign();
    scrollAll();
    await within(screen.getByTestId("design-frame-beacon-busy")).findByRole("img");
    fireEvent.pointerDown(screen.getByTestId("design-frame-beacon-busy"));

    fireEvent.click(pinButton("beacon-busy"));
    const dialog = within(screen.getByRole("dialog"));
    const layer = dialog.getByTestId("pin-layer-beacon-busy");
    // A touch's pointerdown is cancelled, so the browser's follow-up mousedown cannot take focus off the new pin's note.
    expect(fireEvent.pointerDown(layer, { clientX: 100, clientY: 50 })).toBe(false);
    fireEvent.pointerUp(layer, { clientX: 100, clientY: 50 });

    expect(screen.getAllByTestId("pin-layer-beacon-busy")).toHaveLength(1);
    expect(document.activeElement).toBe(dialog.getByLabelText("Note for pin 1"));
    fireEvent.click(dialog.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("pin-marker-beacon-busy-1")).toBeTruthy();
  });

  it("sends a placed pin through the check, then still draws it on the frame, placed no more", async () => {
    const rendered = await renderDesign();
    tap(await pinMode("beacon-busy"), 100, 50);

    expect(await answerAndSend(rendered)).toMatchObject({ variants: [{ key: "beacon-busy", annotations: [{ id: "beacon-busy-1" }] }] });
    await toSection("states");
    scrollAll();
    expect(await screen.findByTestId("pin-marker-beacon-busy-1")).toBeTruthy();
    expect(screen.queryByTestId("pin-layer-beacon-busy")).toBeNull();
  });

  it("offers no Pin on a frame with no image to pin", async () => {
    await renderDesign();
    await toSection("sketch");

    expect(within(screen.getByTestId("frame-feedback-beacon-sketch")).queryByRole("button", { name: /^Pin / })).toBeNull();
    expect(within(screen.getByTestId("frame-feedback-beacon-sketch")).getByText("c chosen · x rejected · m maybe · u clear")).toBeTruthy();
  });

  it("draws a sent round's pins on the frame, with no way to place another", async () => {
    const echo = { verdict: null, comment: "", annotations: [] };
    const pin = { id: "beacon-error-1", width: 375, x: 90, y: 30, xPct: 0.25, yPct: 0.5, note: "Too red." };
    const variants = [{ key: "beacon-error", ...echo, annotations: [pin] }];
    const feedback = { schema: "titan-review/feedback@1", unit: "beacon-states", round: 1, manifestSha256: "0".repeat(64), submittedAt: "2031-03-02T10:00:00.000Z", answers: [], variants, general: "" };
    const staged = await sentRound(DESIGN, feedback);
    onTestFinished(staged.remove);
    await renderDesign({ rounds: staged.source });
    scrollAll();

    const marker = await within(screen.getByTestId("design-frame-beacon-error")).findByTestId("pin-marker-beacon-error-1");
    expect(marker.style.left).toBe("25%");
    expect(screen.queryByRole("button", { name: /^Pin / })).toBeNull();
    fireEvent.pointerDown(screen.getByTestId("design-frame-beacon-error"));
    fireEvent.keyDown(window, { key: "a" });
    expect(screen.queryByTestId("pin-layer-beacon-error")).toBeNull();
  });
});

describe("a design round's frame pins on an element map (TP-3773 S5)", () => {
  beforeEach(layOut);
  afterEach(() => vi.restoreAllMocks());

  /** beacon-busy's record names an element map: the frame's root, and the dot inside it. */
  async function withTargets(): Promise<{ listing: Listing; extra: Snapshot["calls"] }> {
    const listed = await listFrames(source, DESIGN);
    const frames = listed.frames.map((frame) => (frame.key === "beacon-busy" ? { ...frame, targets: true as const } : frame));
    const boxes = [
      { x: 0, y: 0, width: 320, height: 180, target: { testId: "beacon-root" } },
      { x: 150, y: 70, width: 50, height: 30, target: { testId: "beacon-dot", role: "status" } },
    ];
    return { listing: successEnvelope({ ...listed, frames }), extra: { [snapshotKey("rounds.frameTargets", { id: DESIGN, key: "beacon-busy" })]: successEnvelope({ sha256: "0".repeat(64), boxes }) } };
  }

  it("records the innermost element under a pin and names it in the pin list", async () => {
    const rendered = await renderDesign(await withTargets());
    const layer = await pinMode("beacon-busy");
    await waitFor(() => expect(rendered.calls.some((call) => call.name === "rounds.frameTargets")).toBe(true));
    await act(() => Promise.resolve());

    tap(layer, 100, 50);

    expect(screen.getByText("Pin 1 · #beacon-dot status")).toBeTruthy();
    expect(await answerAndSend(rendered)).toMatchObject({
      variants: [{ key: "beacon-busy", annotations: [{ id: "beacon-busy-1", x: 171, y: 85, target: { testId: "beacon-dot", role: "status" } }] }],
    });
  });

  it("reads no element map for a frame whose record names none, so its pin is coordinates only", async () => {
    const rendered = await renderDesign(await withTargets());

    tap(await pinMode("beacon-idle"), 100, 50);

    expect(screen.getByText("Pin 1 · coordinates only")).toBeTruthy();
    expect(rendered.calls.some((call) => call.name === "rounds.frameTargets")).toBe(false);
  });
});

/** The fill pick with each option picking a states frame; three of them, so it is no A/B and the frames stay on the states strip. */
async function withLinkedPick(kind: "pick-one" | "pick-many" = "pick-one"): Promise<Partial<RoundDetail>> {
  const { manifest } = await designRound();
  const linked = { options: ["Filled", "Ring", "Halo"], optionVariants: { Filled: "beacon-idle", Ring: "beacon-busy", Halo: "beacon-error" } };
  const relink = (each: Question): Question => {
    if (each.id !== "beacon-fill-pick" || each.kind !== "pick-one") return each;
    return kind === "pick-one" ? { ...each, ...linked } : { id: each.id, prompt: each.prompt, kind, ...linked };
  };
  return { manifest: { ...manifest, questions: manifest.questions.map(relink) } };
}

/** The fill pick as an A/B whose sides pick Idle and Busy, drawn in its columns. */
async function withABPick(): Promise<Partial<RoundDetail>> {
  const { manifest } = await designRound();
  const ab = { optionVariants: { Filled: "beacon-idle", Ring: "beacon-busy" } };
  return { manifest: { ...manifest, questions: manifest.questions.map((each) => (each.id === "beacon-fill-pick" ? { ...each, ...ab } : each)) } };
}

const checkedOf = (option: string): string | null | undefined => within(screen.getByTestId("round-question-beacon-fill-pick")).getByText(new RegExp(option)).closest("[aria-checked]")?.getAttribute("aria-checked");

describe("a design round's picks and frame verdicts, kept in step (TP-3773 S7)", () => {
  it("marks the frame an option picks Chosen, and un-chooses the frame of the pick it replaced", async () => {
    await renderDesign({ detail: await withLinkedPick() });
    await toSection("fill");

    fireEvent.keyDown(window, { key: "2" });
    fireEvent.keyDown(window, { key: "1" });
    await toSection("states");

    expect(pressedVerdicts("beacon-idle")).toEqual(["Chosen"]);
    expect(pressedVerdicts("beacon-busy")).toEqual([]);
  });

  it("clears the pick when its frame stops being Chosen", async () => {
    await renderDesign({ detail: await withLinkedPick() });
    await toSection("fill");
    fireEvent.keyDown(window, { key: "2" });
    await toSection("states");

    fireEvent.click(verdictButton("beacon-busy", "Chosen"));
    await toSection("fill");

    expect(pickOf("Ring")).toBe("false");
  });

  it("picks the option of a frame chosen on the strip, which un-chooses the frame picked before", async () => {
    const rendered = await renderDesign({ detail: await withLinkedPick() });

    fireEvent.click(verdictButton("beacon-busy", "Chosen"));
    fireEvent.click(verdictButton("beacon-idle", "Chosen"));

    expect(pressedVerdicts("beacon-busy")).toEqual([]);
    await toSection("fill");
    expect(pickOf("Filled")).toBe("true");
    await toSection("sketch");
    expect(await send(rendered)).toMatchObject({ answers: [{ questionId: "beacon-fill-pick", pick: "Filled" }], variants: [{ key: "beacon-idle", verdict: "chosen" }] });
  });

  it("adds a chosen frame's option to a pick-many's picks without replacing them", async () => {
    await renderDesign({ detail: await withLinkedPick("pick-many") });
    await toSection("fill");
    fireEvent.keyDown(window, { key: "1" });
    await toSection("states");

    fireEvent.click(verdictButton("beacon-error", "Chosen"));

    expect(pressedVerdicts("beacon-idle")).toEqual(["Chosen"]);
    await toSection("fill");
    expect([checkedOf("Filled"), checkedOf("Ring"), checkedOf("Halo")]).toEqual(["true", "false", "true"]);
  });

  it("gives each A/B side's frame a verdict that its pick sets", async () => {
    await renderDesign({ detail: await withABPick() });
    await toSection("fill");

    fireEvent.keyDown(window, { key: "1" });
    expect(pressedVerdicts("beacon-idle")).toEqual(["Chosen"]);
    fireEvent.click(verdictButton("beacon-busy", "Chosen"));

    expect(pressedVerdicts("beacon-idle")).toEqual([]);
    expect(within(screen.getByTestId("question-ab-side-beacon-fill-pick-B")).getByRole("button", { name: "Picked B" })).toBeTruthy();
  });
});
