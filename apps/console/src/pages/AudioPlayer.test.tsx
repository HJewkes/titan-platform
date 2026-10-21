// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import type { DataSource } from "@titan-design/rpc-client";
import { RoundSchema, type Manifest } from "../../server/round-schema.js";
import { AudioPlayer, roundAudioUrl } from "./AudioPlayer.js";
import { FrameFeedbackProvider, useFrameFeedback, type ActiveTarget } from "./FrameFeedback.js";
import { QuestionFrames, RoundFramesProvider } from "./QuestionFrames.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** jsdom plays nothing: play and pause fire the events a browser would, and the sound lasts 3 s. */
function mediaPlays(): { play: ReturnType<typeof vi.fn> } {
  const play = vi.fn(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(3);
  return { play };
}

function renderSound(): HTMLAudioElement {
  render(<AudioPlayer src="/media/rounds/chime-r1/audio/chime" label="Chime" transcript="The kettle is ready." durationMs={undefined} />);
  const audio = screen.getByLabelText("Chime");
  if (!(audio instanceof HTMLAudioElement)) throw new Error("expected an audio element");
  fireEvent.loadedMetadata(audio);
  return audio;
}

describe("an audio player", () => {
  it("waits to be played, does not loop, and shows its transcript", () => {
    mediaPlays();
    const audio = renderSound();

    expect(audio.autoplay).toBe(false);
    expect(audio.loop).toBe(false);
    expect(screen.getByText("“The kettle is ready.”")).toBeTruthy();
  });

  it("plays, pauses and scrubs", () => {
    const { play } = mediaPlays();
    const audio = renderSound();

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.change(screen.getByLabelText("Scrub Chime"), { target: { value: "2" } });

    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(audio.currentTime).toBe(2);
  });
});

const notes = { changed: "A chime marks the kettle.", context: "Volume is out of scope." };
const manifest: Manifest = RoundSchema.parse({
  schema: "titan-review/round@2",
  unit: "chime",
  round: 1,
  storybookUrl: "http://127.0.0.1:6006",
  widths: [390],
  variants: [{ key: "chime", audio: "sounds/chime.wav", transcript: "The kettle is ready.", label: "Chime" }],
  sections: [{ id: "sound", title: "Chime", deciding: "Which chime marks the kettle.", ...notes, kind: "STATES", parts: [{ id: "chime", label: "Chime", proposed: "chime: soft" }], variantKeys: ["chime"], questionIds: ["chime-pick"] }],
  questions: [{ id: "chime-pick", kind: "pick-one", prompt: "Does the chime fit?", options: ["yes", "no"], signsOff: "chime", frames: ["chime"] }],
});

/** A design round's frame feedback, so a frame shows its verdict and, where it takes them, its Pin button. */
function WithFeedback({ children }: { children: ReactNode }): ReactNode {
  const [active, setActive] = useState<ActiveTarget>();
  return <FrameFeedbackProvider value={useFrameFeedback(active, setActive, false)}>{children}</FrameFeedbackProvider>;
}

describe("an audio variant in a round", () => {
  it("plays from rounds.audio with its transcript, takes no pins and never asks for a PNG", () => {
    mediaPlays();
    const calls: string[] = [];
    const source: DataSource = { subscribe: () => ({ close: () => undefined }), call: (name) => (calls.push(name), new Promise(() => undefined)) };
    render(
      <RpcProvider source={source}>
        <RoundFramesProvider roundId="chime-r1" manifest={manifest} indexed={new Set(["chime"])}>
          <WithFeedback>
            <QuestionFrames question={manifest.questions[0]!} />
          </WithFeedback>
        </RoundFramesProvider>
      </RpcProvider>,
    );

    expect(screen.getByLabelText("Chime").getAttribute("src")).toBe(roundAudioUrl("chime-r1", "chime"));
    expect(screen.getByText("“The kettle is ready.”")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Verdict on Chime" })).toBeTruthy();
    expect(screen.queryByLabelText("Pin Chime")).toBeNull();
    expect(calls).not.toContain("rounds.frame");
  });
});
