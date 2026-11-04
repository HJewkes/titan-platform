// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import PROPS_JSON from "../../fixtures/explainer/props.json?raw";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { renderPage } from "../render-page.test-helpers.js";

const VIDEO_ID = "v_0123456789abcdef0123";
const VIDEO = { id: VIDEO_ID, title: "relay-explainer.mp4", group: "orbit/render", bytes: 5_500_000, modifiedAt: "2031-03-05T10:00:00.000Z", captions: false, renderNotes: false, noteCount: 0, verdict: null };
const MP4_SHA = "e".repeat(64);
/** The fake explainer's props as `videos.props` returns them: without `found` or explainer's own video id. */
const PROPS = Object.fromEntries(Object.entries(z.record(z.string(), z.unknown()).parse(JSON.parse(PROPS_JSON))).filter(([key]) => key !== "found" && key !== "videoId"));

type Call = { name: string; args: unknown };
type Tap = (args: unknown) => Promise<JsonEnvelope<unknown>>;

const verdict = (problems: string[], diff: unknown[]) => successEnvelope({ verdict: { ok: problems.length === 0, problems, diff }, gaps: [] });

afterEach(cleanup);

interface Setup {
  props?: unknown;
  /** Answers `videos.edit-check`. */
  tap?: Tap;
  /** Answers `videos.edit`. */
  save?: Tap;
  hash?: string;
  notes?: unknown[];
  edits?: unknown[];
}

const SAVED = successEnvelope({ saved: { editId: "edit-00000000000000bb", scriptSha: "6".repeat(64), started: true }, problems: [], gaps: [] });
const SAVE_ON = { ...PROPS, saveBack: { enabled: true } };

/** The player over recorded reads; `videos.edit-check` and `videos.edit` answer as `tap` and `save` say, and every call is recorded. */
function renderPlayer({ props = { mp4Sha: MP4_SHA, props: PROPS, gaps: [] }, tap = () => Promise.resolve(verdict([], [])), save = () => Promise.resolve(SAVED), hash = `#/theater/${VIDEO_ID}`, notes = [], edits = [] }: Setup = {}, { inApp = false } = {}): Call[] {
  const snapshot: Snapshot = {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T12:00:00.000Z",
    calls: {
      [snapshotKey("videos.list", {})]: successEnvelope({ videos: [VIDEO], truncated: false, gaps: [] }),
      [snapshotKey("videos.notes", { videoId: VIDEO_ID })]: successEnvelope({ video: VIDEO.title, notes, verdict: null, gaps: [] }),
      [snapshotKey("videos.props", { videoId: VIDEO_ID })]: successEnvelope(props),
      [snapshotKey("videos.edits", { videoId: VIDEO_ID })]: successEnvelope({ edits, gaps: [] }),
    },
  };
  const taps: Record<string, Tap> = { "videos.edit-check": tap, "videos.edit": save };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const calls: Call[] = [];
  const source: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (calls.push({ name, args }), taps[name]?.(args) ?? inner.call(name, args, options)),
  };
  renderPage(source, hash, { answers: source, inApp });
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
    renderPlayer({}, { inApp: true });
    const element = await pauseAt(6.4);

    fireEvent.click(await screen.findByText("Edit this beat (b-list)"));

    expect(await screen.findByText("Beat b-list · list")).toBeTruthy();
    expect(element.currentTime).toBe(12.5);
  });

  it("opens the beat under `?t=` when the link says `edit=1`", async () => {
    renderPlayer({ hash: `#/theater/${VIDEO_ID}?t=2&edit=1` });

    expect(await screen.findByText("Beat b-compare · compare")).toBeTruthy();
  });

  it("shows Save disabled with explainer's reason while renders ignore edits", async () => {
    renderPlayer();
    await pauseAt(1);
    fireEvent.click(await screen.findByText("Edit this beat (b-compare)"));
    fireEvent.change(await screen.findByLabelText("leftTitle"), { target: { value: "Polling loop" } });

    const save = screen.getByTestId("beat-editor-save");

    expect(save.getAttribute("aria-disabled") === "true" || save.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("beat-editor-save-reason").textContent).toBe("Save is off: renders ignore edits until TP-2992 S3");
  });

  it("shows a props gap as a line and offers no editor", async () => {
    renderPlayer({ props: { mp4Sha: MP4_SHA, props: null, gaps: ["explainer props exited 2: props: run has no words artifact"] } });
    await pauseAt(1);

    expect((await screen.findByTestId("beat-editor-gap")).textContent).toBe("Beat editor: explainer props exited 2: props: run has no words artifact");
    expect(screen.queryByTestId("theater-edit-beat")).toBeNull();
  });
});

describe("the draft check", () => {
  it("checks the draft once typing pauses, then shows the field's error and the before and after", async () => {
    const problem = "beats.b-compare.visual.slots.leftTitle: Too big: expected string to have <=48 characters";
    const diff = [{ beat: "b-compare", path: "visual.slots.leftTitle", before: "Polling", after: "Polling every few seconds from each station" }];
    const calls = renderPlayer({ tap: () => Promise.resolve(verdict([problem], diff)) });
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

const callsOf = (calls: Call[], name: string) => calls.filter((call) => call.name === name).map((call) => call.args);
const isDisabled = (element: HTMLElement) => element.getAttribute("aria-disabled") === "true" || element.hasAttribute("disabled");
const NOTE = {
  schema: "titan-console/video-note@1", id: "0123456789abcdef", videoId: VIDEO_ID, video: VIDEO.title, renderSha256: MP4_SHA,
  atS: 7, createdAt: "2031-03-05T11:00:00.000Z", kind: "comment", about: "content", text: "Say ready to ship", current: true,
};

async function openBeatAt(seconds: number, beatId: string): Promise<void> {
  await pauseAt(seconds);
  fireEvent.click(await screen.findByText(`Edit this beat (${beatId})`));
}

describe("Save and render", () => {
  it("saves edits to two beats as one videos.edit once explainer says renders read edits", async () => {
    const calls = renderPlayer({ props: { mp4Sha: MP4_SHA, props: SAVE_ON, gaps: [] } });
    await openBeatAt(1, "b-compare");
    fireEvent.change(await screen.findByLabelText("leftTitle"), { target: { value: "Polling loop" } });
    fireEvent.click(screen.getByTestId("beat-editor-close"));
    await openBeatAt(7, "b-list");
    fireEvent.change(await screen.findByLabelText("title"), { target: { value: "Ready to ship" } });

    const save = screen.getByTestId("beat-editor-save");
    expect(isDisabled(save)).toBe(false);
    expect(screen.getByTestId("beat-editor-save-reason").textContent).toBe("2 beats in this draft render together as one run.");
    fireEvent.click(save);

    expect((await screen.findByTestId("beat-editor-saved")).textContent).toBe("Saved as edit-00000000000000bb; its run is starting.");
    expect(callsOf(calls, "videos.edit")).toEqual([
      { videoId: VIDEO_ID, runId: "run-synthetic-0001", scriptSha: "5".repeat(64), beats: { "b-compare": { slots: { leftTitle: "Polling loop" } }, "b-list": { slots: { title: "Ready to ship" } } } },
    ]);
  });

  it("keeps Save off until the draft changes a field", async () => {
    renderPlayer({ props: { mp4Sha: MP4_SHA, props: SAVE_ON, gaps: [] } });
    await openBeatAt(1, "b-compare");

    const save = await screen.findByTestId("beat-editor-save");

    expect(isDisabled(save)).toBe(true);
    expect(screen.getByTestId("beat-editor-save-reason").textContent).toBe("Change a field to start a draft. Edits to several beats save together as one render.");
  });

  it("shows explainer's refusal and keeps the draft", async () => {
    const refusal = "edit: edit edit-00000000000000aa already started run run-synthetic-0002; one save makes one run";
    renderPlayer({ props: { mp4Sha: MP4_SHA, props: SAVE_ON, gaps: [] }, save: () => Promise.resolve(successEnvelope({ saved: null, problems: [refusal], gaps: [] })) });
    await openBeatAt(1, "b-compare");
    fireEvent.change(await screen.findByLabelText("leftTitle"), { target: { value: "Polling loop" } });

    fireEvent.click(screen.getByTestId("beat-editor-save"));

    expect((await screen.findByTestId("beat-editor-save-refused")).textContent).toContain(refusal);
    expect(screen.getByLabelText<HTMLInputElement>("leftTitle").value).toBe("Polling loop");
  });
});

describe("Turn into edit", () => {
  it("opens the beat under the note's time and saves the draft citing the note", async () => {
    const calls = renderPlayer({ props: { mp4Sha: MP4_SHA, props: SAVE_ON, gaps: [] }, notes: [NOTE] });

    fireEvent.click(await screen.findByTestId(`theater-note-edit-${NOTE.id}`));
    expect(await screen.findByText("Beat b-list · list")).toBeTruthy();
    expect(screen.getByTestId("beat-editor-from-note").textContent).toBe("This draft cites the note at 0:07");
    fireEvent.change(await screen.findByLabelText("title"), { target: { value: "Ready to ship" } });
    fireEvent.click(screen.getByTestId("beat-editor-save"));

    await screen.findByTestId("beat-editor-saved");
    expect(callsOf(calls, "videos.edit")).toEqual([expect.objectContaining({ fromNote: NOTE.id, beats: { "b-list": { slots: { title: "Ready to ship" } } } })]);
  });

  it("is not offered on a note made on an earlier render", async () => {
    renderPlayer({ props: { mp4Sha: MP4_SHA, props: SAVE_ON, gaps: [] }, notes: [{ ...NOTE, current: false }] });

    await screen.findByTestId(`theater-note-${NOTE.id}`);

    expect(screen.queryByTestId(`theater-note-edit-${NOTE.id}`)).toBeNull();
  });
});

describe("the saved edits", () => {
  it("lists each edit of the video with its beats and its run's status", async () => {
    const base = { runId: "run-synthetic-0001", scriptSha: "5".repeat(64), mp4Sha: MP4_SHA };
    const edits = [
      { editId: "edit-00000000000000aa", base, beats: { "b-list": { slots: { title: "Ready" } } }, fromNote: NOTE.id, createdAt: "2031-03-05T11:00:00.000Z", status: "started", runId: "run-synthetic-0002", runStatus: "completed" },
      { editId: "edit-00000000000000cc", base, beats: { "b-compare": {}, "b-list": {} }, createdAt: "2031-03-05T11:30:00.000Z", status: "started", runStatus: "failed" },
    ];
    renderPlayer({ edits });

    expect((await screen.findByTestId("theater-edit-status-edit-00000000000000aa")).textContent).toBe("run completed");
    expect(screen.getByTestId("theater-edit-status-edit-00000000000000cc").textContent).toBe("run failed");
    expect(screen.getByTestId("theater-edit-edit-00000000000000cc").textContent).toContain("2 beats: b-compare, b-list");
  });
});
