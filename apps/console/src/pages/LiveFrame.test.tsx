// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import type { DataSource } from "@titan-design/rpc-client";
import { RoundSchema, type Manifest, type Question } from "../../server/round-schema.js";
import { BRIDGE_TAG } from "../../server/story-bridge.js";
import type { RoundLive } from "../../server/storybook-build.js";
import { QuestionFrames, RoundFramesProvider } from "./QuestionFrames.js";
import { PHONE_WIDTH, READY_TIMEOUT_MS } from "./live-frame.js";

/** Every frame is near the viewport as soon as it is observed. */
class InViewObserver {
  constructor(private readonly callback: (entries: Pick<IntersectionObserverEntry, "target" | "isIntersecting">[]) => void) {}
  observe(target: Element): void {
    this.callback([{ target, isIntersecting: true }]);
  }
  disconnect(): void {}
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", InViewObserver));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ROUND = "lantern-cards-r1";
const STORY_ORIGIN = "http://127.0.0.1:7501";
const BUILD = "b".repeat(64);
const SHA = "a".repeat(40);
const PNG = "iVBORw0KGgo=";
const notes = { changed: "Two densities replace the single card.", context: "Card colours are out of scope." };
const KEYS = ["compact", "roomy", "sketch", ...Array.from({ length: 9 }, (_, at) => `card-${at}`)];

const manifest: Manifest = RoundSchema.parse({
  schema: "titan-review/round@2",
  unit: "lantern-cards",
  round: 1,
  storybookUrl: "http://127.0.0.1:6006",
  widths: [390],
  variants: KEYS.map((key) => ({ key, storyId: `lantern-card--${key}`, label: `Card ${key}` })),
  sections: [
    { id: "density", title: "Card density", deciding: "Which density the cards use.", ...notes, kind: "CHOICE", variantKeys: ["compact", "roomy"], questionIds: ["density-pick"] },
    { id: "ship", title: "Ship it", deciding: "Whether the card ships.", ...notes, kind: "STATES", variantKeys: ["sketch"], questionIds: ["card-ship"] },
    { id: "grid", title: "Card grid", deciding: "How many cards fit.", ...notes, kind: "STATES", variantKeys: KEYS.slice(3), questionIds: ["grid-pick"] },
  ],
  questions: [
    { id: "density-pick", kind: "pick-one", prompt: "Which density?", options: ["compact", "roomy"], frames: ["compact", "roomy"], signsOff: "card-density" },
    { id: "card-ship", kind: "pick-one", decision: "ship", prompt: "Ship the card?", options: ["Release", "Hold"], frames: ["sketch"], signsOff: "card-release" },
    { id: "grid-pick", kind: "pick-one", prompt: "Which grid?", options: ["dense", "loose"], frames: KEYS.slice(3), signsOff: "card-grid" },
  ],
});

const question = (id: string): Question => {
  const found = manifest.questions.find((each) => each.id === id);
  if (found === undefined) throw new Error(`no question ${id}`);
  return found;
};

const storyUrl = (key: string): string => `/sb/${BUILD}/iframe.html?id=lantern-card--${key}&viewMode=story`;
const allLive: RoundLive = { origin: STORY_ORIGIN, frames: Object.fromEntries(KEYS.map((key) => [key, { url: storyUrl(key), buildSha: SHA }])) };

/** rounds.frame answers a PNG for every key, so each frame's placeholder and fallback is its captured image. */
const pngs: DataSource = {
  subscribe: () => ({ close: () => undefined }),
  call: () => Promise.resolve(successEnvelope({ contentType: "image/png", bytes: 8, sha256: "c".repeat(64), base64: PNG })),
};

function renderQuestion(id: string, live: RoundLive = allLive): void {
  render(
    <RpcProvider source={pngs}>
      <RoundFramesProvider roundId={ROUND} manifest={manifest} indexed={new Set(KEYS)} live={live}>
        <QuestionFrames question={question(id)} />
      </RoundFramesProvider>
    </RpcProvider>,
  );
}

const frameOf = (key: string): HTMLIFrameElement => {
  const frame = screen.getByTitle(`Card ${key}, live at 390px`);
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("expected an iframe");
  return frame;
};

/** A message as the page's window receives it, from `source` on `origin`. */
function post(source: Window | null, data: unknown, origin = STORY_ORIGIN): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
  });
}

const ready = { bridge: BRIDGE_TAG, type: "ready" };
const placeholder = (key: string): HTMLElement | null => screen.queryByAltText(`Card ${key}`);

describe("a live story frame", () => {
  it("is sandboxed to scripts, its own origin and forms, with no permissions", async () => {
    renderQuestion("density-pick");
    await screen.findAllByAltText("Card compact");

    const frame = frameOf("compact");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("src")).toBe(`${STORY_ORIGIN}${storyUrl("compact")}&parent=${encodeURIComponent(window.location.origin)}`);
  });

  it("swaps its PNG for the story on its own frame's ready, and ignores the same message from another window", async () => {
    renderQuestion("density-pick");
    await screen.findByAltText("Card compact");

    post(frameOf("roomy").contentWindow, ready);
    post(frameOf("compact").contentWindow, ready, "http://127.0.0.1:7500");
    expect(placeholder("compact")).not.toBeNull();

    post(frameOf("compact").contentWindow, ready);
    expect(placeholder("compact")).toBeNull();
    expect(frameOf("compact").className).not.toContain("invisible");
  });

  it("remounts once when no ready comes within 10 s, then shows the PNG with a notice and Retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    renderQuestion("density-pick");
    await screen.findByAltText("Card compact");
    const first = frameOf("compact");

    act(() => vi.advanceTimersByTime(READY_TIMEOUT_MS));
    expect(frameOf("compact")).not.toBe(first);
    expect(screen.queryAllByText(/Live story unavailable/)).toHaveLength(0);

    act(() => vi.advanceTimersByTime(READY_TIMEOUT_MS));
    expect(screen.queryByTitle("Card compact, live at 390px")).toBeNull();
    expect(screen.getAllByText("390px · Live story unavailable: showing the captured frame")).toHaveLength(2);
    expect(placeholder("compact")).not.toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);
    expect(frameOf("compact")).toBeTruthy();
  });

  it("in a Ship-bound section shows the approved PNG with Open live, and mounts no story until asked", async () => {
    renderQuestion("card-ship");
    await screen.findByAltText("Card sketch");

    expect(screen.queryByTitle("Card sketch, live at 390px")).toBeNull();
    expect(screen.getByText("The approved frame is the captured PNG")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open live" }));
    expect(frameOf("sketch")).toBeTruthy();
  });

  it("mounts at most 4 stories on a phone; the rest wait as their PNG", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === PHONE_WIDTH, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
    renderQuestion("grid-pick");
    await screen.findAllByAltText("Card card-8");

    expect(document.querySelectorAll("iframe")).toHaveLength(4);
    expect(screen.getAllByText("390px live frame paused: too many live frames on screen")).toHaveLength(5);
  });

  it("with only a reason, shows its PNG and the reason, and mounts no story", async () => {
    const reason = "Live build is for aaaaaaa; this round is at ddddddd";
    renderQuestion("density-pick", { origin: STORY_ORIGIN, frames: { ...allLive.frames, compact: { reason } } });
    await screen.findAllByAltText("Card compact");

    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByTitle("Card compact, live at 390px")).toBeNull();
    expect(frameOf("roomy")).toBeTruthy();
  });
});
