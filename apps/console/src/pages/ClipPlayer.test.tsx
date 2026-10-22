// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import type { DataSource } from "@titan-design/rpc-client";
import { RoundSchema, type Manifest } from "../../server/round-schema.js";
import { ClipPlayer, roundClipUrl } from "./ClipPlayer.js";
import { QuestionFrames, RoundFramesProvider } from "./QuestionFrames.js";

/** Every frame nears the viewport as soon as it is observed. */
class NearObserver {
  constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe(): void {
    this.callback([{ isIntersecting: true }]);
  }
  disconnect(): void {}
}

/** jsdom plays nothing: play and pause fire the events a browser would, and the clip lasts 2 s. */
function mediaPlays(): { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> } {
  const play = vi.fn(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  const pause = vi.fn(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(2);
  return { play, pause };
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", NearObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const KEYFRAMES = [
  { atMs: 0, label: "dark" },
  { atMs: 500, label: "glow" },
  { atMs: 1500, label: "ash" },
];

function renderPlayer(props: Partial<Parameters<typeof ClipPlayer>[0]> = {}): HTMLVideoElement {
  render(<ClipPlayer src="/media/rounds/ember-r1/clip/ember" label="Ember fade" keyframes={KEYFRAMES} {...props} />);
  const video = screen.getByLabelText("Ember fade");
  if (!(video instanceof HTMLVideoElement)) throw new Error("expected a video");
  fireEvent.loadedMetadata(video);
  return video;
}

const button = (name: string): HTMLElement => screen.getByRole("button", { name });
const scrubber = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>("Scrub Ember fade");

describe("a clip player", () => {
  it("starts muted, autoplaying and looping, as a clip motion defaults it", () => {
    mediaPlays();
    const video = renderPlayer();

    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(video.loop).toBe(true);
    expect(button("Loop").getAttribute("aria-pressed")).toBe("true");
  });

  it("plays and pauses from one button that names what it will do", () => {
    const { play, pause } = mediaPlays();
    renderPlayer();

    fireEvent.click(button("Play"));
    expect(play).toHaveBeenCalledTimes(1);

    fireEvent.click(button("Pause"));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(button("Play")).toBeTruthy();
  });

  it("turns looping off and on again", () => {
    mediaPlays();
    const video = renderPlayer({ loop: false });
    expect(video.loop).toBe(false);

    fireEvent.click(button("Loop"));

    expect(video.loop).toBe(true);
    expect(button("Loop").getAttribute("aria-pressed")).toBe("true");
  });

  it("seeks where the scrubber is dragged, across the clip's loaded length", () => {
    mediaPlays();
    const video = renderPlayer();
    expect(scrubber().max).toBe("2");

    fireEvent.change(scrubber(), { target: { value: "1.25" } });

    expect(video.currentTime).toBe(1.25);
    expect(screen.getByText("1.3 s / 2.0 s")).toBeTruthy();
  });

  it("seeks to a keyframe's moment when its button is pressed", () => {
    mediaPlays();
    const video = renderPlayer();

    fireEvent.click(button("Seek to glow"));

    expect(video.currentTime).toBe(0.5);
    expect(scrubber().value).toBe("0.5");
  });

  it("follows the clip as it plays", () => {
    mediaPlays();
    const video = renderPlayer();
    video.currentTime = 1.5;

    fireEvent.timeUpdate(video);

    expect(scrubber().value).toBe("1.5");
  });

  it("draws no keyframe row when the motion names none", () => {
    mediaPlays();
    renderPlayer({ keyframes: [] });

    expect(screen.queryByText("Keyframes:")).toBeNull();
  });
});

const ROUND = "ember-motion-r1";
const notes = { changed: "The ember glows before it fades.", context: "Colour is out of scope." };
const manifest: Manifest = RoundSchema.parse({
  schema: "titan-review/round@2",
  unit: "ember-motion",
  round: 1,
  storybookUrl: "http://127.0.0.1:6006",
  widths: [390],
  variants: [{ key: "ember", clip: "clips/ember.mp4", label: "Ember fade", motion: { mechanism: "clip", loop: false, keyframes: KEYFRAMES } }],
  sections: [{ id: "fade", title: "Ember fade", deciding: "How the ember fades.", ...notes, kind: "STATES", parts: [{ id: "ember-fade", label: "Ember fade", proposed: "fade: 500ms" }], variantKeys: ["ember"], questionIds: ["fade-pick"] }],
  questions: [{ id: "fade-pick", kind: "pick-one", prompt: "Does the fade read?", options: ["yes", "no"], signsOff: "ember-fade", frames: ["ember"] }],
});

describe("a clip variant in a round", () => {
  it("plays from rounds.clip with its motion's keyframes, and never asks for a PNG", () => {
    mediaPlays();
    const calls: string[] = [];
    const source: DataSource = { subscribe: () => ({ close: () => undefined }), call: (name) => (calls.push(name), new Promise(() => undefined)) };
    render(
      <RpcProvider source={source}>
        <RoundFramesProvider roundId={ROUND} manifest={manifest}>
          <QuestionFrames question={manifest.questions[0]!} />
        </RoundFramesProvider>
      </RpcProvider>,
    );

    const video = screen.getByLabelText("Ember fade");
    expect(video.getAttribute("src")).toBe(roundClipUrl(ROUND, "ember"));
    expect(video).toHaveProperty("loop", false);
    expect(button("Seek to ash")).toBeTruthy();
    expect(calls).not.toContain("rounds.frame");
  });
});
