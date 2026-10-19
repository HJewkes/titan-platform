// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { App } from "../App.js";
import { AnswerSourceProvider } from "../data/submit.js";

const VIDEO_ID = "v_0123456789abcdef0123";
const VIDEO = { id: VIDEO_ID, title: "lantern-explainer.mp4", group: "orbit/render", bytes: 5_500_000, modifiedAt: "2031-03-05T10:00:00.000Z", captions: false, renderNotes: false, noteCount: 0, verdict: null };

type Tap = (args: unknown) => Promise<JsonEnvelope<unknown>>;
type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;

let nextFrame: FrameCallback | null = null;
/** The frame the browser presents as the video stops; the stubbed `pause` delivers it. */
let frameOnPause: number | null = null;

beforeEach(() => {
  nextFrame = null;
  frameOnPause = null;
  Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", { configurable: true, value: (callback: FrameCallback) => ((nextFrame = callback), 1) });
  Object.defineProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback", { configurable: true, value: () => undefined });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
    if (frameOnPause !== null) present(frameOnPause);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
});

function present(mediaTime: number): void {
  const callback = nextFrame;
  nextFrame = null;
  callback?.(0, { mediaTime });
}

/** The player over recorded reads; `videos.note` answers as `tap` says, and every call is recorded. */
function renderPlayer(tap: Tap = () => Promise.resolve(successEnvelope({}))): { name: string; args: unknown }[] {
  const snapshot: Snapshot = {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T12:00:00.000Z",
    calls: {
      [snapshotKey("videos.list", {})]: successEnvelope({ videos: [VIDEO], truncated: false, gaps: [] }),
      [snapshotKey("videos.notes", { videoId: VIDEO_ID })]: successEnvelope({ video: VIDEO.title, notes: [], verdict: null, gaps: [] }),
    },
  };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const calls: { name: string; args: unknown }[] = [];
  const source: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (calls.push({ name, args }), name === "videos.note" ? tap(args) : inner.call(name, args, options)),
  };
  window.location.hash = `#/theater/${VIDEO_ID}`;
  render(
    <RpcProvider source={source}>
      <AnswerSourceProvider value={source}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  return calls;
}

const notesSent = (calls: { name: string; args: unknown }[]) => calls.filter((call) => call.name === "videos.note").map((call) => call.args);

describe("pause to comment", () => {
  it("pauses, stamps the frame shown after the pause rather than the clock, and sends the comment", async () => {
    const calls = renderPlayer();
    const element = await screen.findByTestId<HTMLVideoElement>("theater-video");
    present(71.9);
    element.currentTime = 72.4;
    frameOnPause = 72.125;
    fireEvent.click(await screen.findByTestId("theater-comment-start"));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
    fireEvent.change(await screen.findByLabelText("Comment text"), { target: { value: "tighten the outro" } });
    fireEvent.click(screen.getByTestId("theater-comment-send"));
    await waitFor(() => expect(notesSent(calls)).toEqual([{ videoId: VIDEO_ID, kind: "comment", atS: 72.125, text: "tighten the outro" }]));
    await waitFor(() => expect(screen.queryByLabelText("Comment text")).toBeNull());
  });

  it("falls back to the playhead when the browser has no frame callbacks", async () => {
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
    const calls = renderPlayer();
    const element = await screen.findByTestId<HTMLVideoElement>("theater-video");
    element.currentTime = 9.5;
    fireEvent.click(await screen.findByTestId("theater-comment-start"));
    fireEvent.change(await screen.findByLabelText("Comment text"), { target: { value: "the title card runs long" } });
    fireEvent.click(screen.getByTestId("theater-comment-send"));
    await waitFor(() => expect(notesSent(calls)).toEqual([{ videoId: VIDEO_ID, kind: "comment", atS: 9.5, text: "the title card runs long" }]));
  });

  it("labels the button with the playhead", async () => {
    renderPlayer();
    const element = await screen.findByTestId<HTMLVideoElement>("theater-video");
    element.currentTime = 95;
    fireEvent(element, new Event("timeupdate"));
    expect((await screen.findByTestId("theater-comment-start")).textContent).toBe("Comment at 1:35");
  });
});

describe("verdicts", () => {
  it("sends Ship as a verdict at the frame on screen", async () => {
    const calls = renderPlayer();
    await screen.findByTestId("theater-video");
    present(30.25);
    fireEvent.click(await screen.findByTestId("theater-verdict-ship"));
    await waitFor(() => expect(notesSent(calls)).toEqual([{ videoId: VIDEO_ID, kind: "verdict", atS: 30.25, verdict: "ship" }]));
  });

  it("shows a refused owner write verbatim and keeps the draft", async () => {
    renderPlayer(() => Promise.resolve(errorEnvelope("owner writes are off on this console", 77)));
    fireEvent.click(await screen.findByTestId("theater-comment-start"));
    fireEvent.change(await screen.findByLabelText("Comment text"), { target: { value: "tighten the outro" } });
    fireEvent.click(screen.getByTestId("theater-comment-send"));
    expect((await screen.findByTestId("theater-comment-error")).textContent).toContain("owner writes are off on this console");
    expect(screen.getByLabelText<HTMLTextAreaElement>("Comment text").value).toBe("tighten the outro");
  });
});
