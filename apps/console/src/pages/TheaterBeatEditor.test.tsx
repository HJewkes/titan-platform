// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import PROPS_JSON from "../../fixtures/explainer/props.json?raw";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { App } from "../App.js";
import { AnswerSourceProvider } from "../data/submit.js";

const VIDEO_ID = "v_0123456789abcdef0123";
const VIDEO = { id: VIDEO_ID, title: "relay-explainer.mp4", group: "orbit/render", bytes: 5_500_000, modifiedAt: "2031-03-05T10:00:00.000Z", captions: false, renderNotes: false, noteCount: 0, verdict: null };
const MP4_SHA = "e".repeat(64);
/** The fake explainer's props as `videos.props` returns them: without `found` or explainer's own video id. */
const PROPS = Object.fromEntries(Object.entries(z.record(z.string(), z.unknown()).parse(JSON.parse(PROPS_JSON))).filter(([key]) => key !== "found" && key !== "videoId"));

type Call = { name: string; args: unknown };
type Tap = (args: unknown) => Promise<JsonEnvelope<unknown>>;

const verdict = (problems: string[], diff: unknown[]) => successEnvelope({ verdict: { ok: problems.length === 0, problems, diff }, gaps: [] });

afterEach(cleanup);

/** The player over recorded reads, with `videos.props` as given; `videos.edit-check` answers as `tap` says, and every call is recorded. */
function renderPlayer(props: unknown = { mp4Sha: MP4_SHA, props: PROPS, gaps: [] }, tap: Tap = () => Promise.resolve(verdict([], [])), hash = `#/theater/${VIDEO_ID}`): Call[] {
  const snapshot: Snapshot = {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T12:00:00.000Z",
    calls: {
      [snapshotKey("videos.list", {})]: successEnvelope({ videos: [VIDEO], truncated: false, gaps: [] }),
      [snapshotKey("videos.notes", { videoId: VIDEO_ID })]: successEnvelope({ video: VIDEO.title, notes: [], verdict: null, gaps: [] }),
      [snapshotKey("videos.props", { videoId: VIDEO_ID })]: successEnvelope(props),
    },
  };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const calls: Call[] = [];
  const source: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (calls.push({ name, args }), name === "videos.edit-check" ? tap(args) : inner.call(name, args, options)),
  };
  window.location.hash = hash;
  render(
    <RpcProvider source={source}>
      <AnswerSourceProvider value={source}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  return calls;
}

/** jsdom loads no media: the test says the metadata arrived, then stops the playhead at `seconds`. */
async function pauseAt(seconds: number): Promise<HTMLVideoElement> {
  const element = await screen.findByTestId<HTMLVideoElement>("theater-video");
  Object.defineProperty(element, "readyState", { configurable: true, value: HTMLMediaElement.HAVE_METADATA });
  element.currentTime = seconds;
  fireEvent(element, new Event("seeked"));
  return element;
}

const checks = (calls: Call[]) => calls.filter((call) => call.name === "videos.edit-check").map((call) => call.args);

describe("Edit this beat", () => {
  it("opens the beat whose [startS, endS) holds the paused playhead and seeks the player to its still", async () => {
    renderPlayer();
    const element = await pauseAt(6.4);

    fireEvent.click(await screen.findByText("Edit this beat (b-list)"));

    expect(await screen.findByText("Beat b-list · list")).toBeTruthy();
    expect(element.currentTime).toBe(12.5);
  });

  it("opens the beat under `?t=` when the link says `edit=1`", async () => {
    renderPlayer(undefined, undefined, `#/theater/${VIDEO_ID}?t=2&edit=1`);

    expect(await screen.findByText("Beat b-compare · compare")).toBeTruthy();
  });

  it("shows Save disabled with explainer's reason while renders ignore edits", async () => {
    renderPlayer();
    await pauseAt(1);
    fireEvent.click(await screen.findByText("Edit this beat (b-compare)"));

    const save = await screen.findByTestId("beat-editor-save");

    expect(save.getAttribute("aria-disabled") === "true" || save.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("beat-editor-save-reason").textContent).toBe("Save is off: renders ignore edits until TP-2992 S3");
  });

  it("shows a props gap as a line and offers no editor", async () => {
    renderPlayer({ mp4Sha: MP4_SHA, props: null, gaps: ["explainer props exited 2: props: run has no words artifact"] });
    await pauseAt(1);

    expect((await screen.findByTestId("beat-editor-gap")).textContent).toBe("Beat editor: explainer props exited 2: props: run has no words artifact");
    expect(screen.queryByTestId("theater-edit-beat")).toBeNull();
  });
});

describe("the draft check", () => {
  it("checks the draft once typing pauses, then shows the field's error and the before and after", async () => {
    const problem = "beats.b-compare.visual.slots.leftTitle: Too big: expected string to have <=48 characters";
    const diff = [{ beat: "b-compare", path: "visual.slots.leftTitle", before: "Polling", after: "Polling every few seconds from each station" }];
    const calls = renderPlayer(undefined, () => Promise.resolve(verdict([problem], diff)));
    await pauseAt(1);
    fireEvent.click(await screen.findByText("Edit this beat (b-compare)"));

    const title = await screen.findByLabelText("leftTitle");
    fireEvent.change(title, { target: { value: "Polling every few" } });
    fireEvent.change(title, { target: { value: "Polling every few seconds from each station" } });

    await waitFor(() => expect(screen.getByTestId("beat-editor-diff-visual.slots.leftTitle").textContent).toContain("Polling every few seconds from each station"));
    expect(checks(calls)).toEqual([{ videoId: VIDEO_ID, runId: "run-synthetic-0001", scriptSha: "5".repeat(64), beats: { "b-compare": { slots: { leftTitle: "Polling every few seconds from each station" } } } }]);
    expect(screen.getByTestId("beat-editor").textContent).toContain("Too big: expected string to have <=48 characters");
  });

  it("keeps a row a cue targets: its id reads only and its Remove is off", async () => {
    renderPlayer();
    await pauseAt(1);
    fireEvent.click(await screen.findByText("Edit this beat (b-compare)"));

    const lockedId = await screen.findByLabelText<HTMLInputElement>("rows.0.id");
    const remove = screen.getByTestId("slot-rows-0-remove");

    expect(lockedId.readOnly).toBe(true);
    expect(remove.getAttribute("aria-disabled") === "true" || remove.hasAttribute("disabled")).toBe(true);
  });
});
