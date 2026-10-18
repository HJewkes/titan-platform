// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { App } from "../App.js";
import { ROOTS_UNSET } from "../../server/videos.js";
import { startTimeOf } from "./TheaterPlayer.js";

afterEach(cleanup);

const WITH_CAPTIONS = "v_0123456789abcdef0123";
const WITHOUT_CAPTIONS = "v_fedcba9876543210fedc";
const SHA_NOW = "a".repeat(64);
const SHA_BEFORE = "b".repeat(64);

function video(id: string, title: string, group: string, captions: boolean, modifiedAt: string) {
  return { id, title, group, bytes: 5_500_000, modifiedAt, captions, renderNotes: false, noteCount: 0, verdict: null };
}

const VIDEOS = [
  { ...video(WITH_CAPTIONS, "lantern-explainer.mp4", "orbit/render", true, "2031-03-05T10:00:00.000Z"), noteCount: 1, verdict: "needs-changes" as const },
  video(WITHOUT_CAPTIONS, "kiln-sample.webm", "kiln", false, "2031-03-04T10:00:00.000Z"),
];

function note(id: string, atS: number, text: string, current: boolean) {
  return {
    schema: "titan-console/video-note@1" as const,
    id,
    videoId: WITH_CAPTIONS,
    video: "lantern-explainer.mp4",
    renderSha256: current ? SHA_NOW : SHA_BEFORE,
    atS,
    kind: "comment" as const,
    text,
    createdAt: "2031-03-05T11:00:00.000Z",
    current,
  };
}

const NOTES = [note("00000000000000a2", 42.5, "tighten the outro", true), note("00000000000000a1", 7.25, "the title card runs long", false)];

function snapshotOf(list: unknown): Snapshot {
  const notesOf = (videoId: string, notes: unknown[]) => [snapshotKey("videos.notes", { videoId }), successEnvelope({ video: "x.mp4", notes, verdict: null, gaps: [] })];
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T12:00:00.000Z",
    calls: Object.fromEntries([[snapshotKey("videos.list", {}), successEnvelope(list)], notesOf(WITH_CAPTIONS, NOTES), notesOf(WITHOUT_CAPTIONS, [])]),
  };
}

const LISTED = snapshotOf({ videos: VIDEOS, truncated: false, gaps: [] });

function renderConsole(hash: string, snapshot: Snapshot = LISTED): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  window.location.hash = hash;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

/** jsdom never loads media, so a test says when the metadata has arrived. */
function metadataLoaded(element: HTMLVideoElement): void {
  Object.defineProperty(element, "readyState", { configurable: true, value: HTMLMediaElement.HAVE_METADATA });
  fireEvent(element, new Event("loadedmetadata"));
}

describe("the theater list", () => {
  it("shows the gap line when no roots are set", async () => {
    renderConsole("#/theater", snapshotOf({ videos: [], truncated: false, gaps: [ROOTS_UNSET] }));
    expect((await screen.findByTestId("theater-gap")).textContent).toContain(ROOTS_UNSET);
    expect(screen.getByText("No videos yet")).toBeTruthy();
  });

  it("groups videos by folder, newest group first, with verdict and note badges", async () => {
    renderConsole("#/theater");
    await screen.findByTestId("theater-group-orbit/render");
    expect(screen.getAllByTestId(/^theater-group-/).map((group) => group.getAttribute("data-testid"))).toEqual(["theater-group-orbit/render", "theater-group-kiln"]);
    const card = screen.getByTestId(`theater-video-${WITH_CAPTIONS}`);
    expect(within(card).getByText("Needs changes")).toBeTruthy();
    expect(within(card).getByText("1 note")).toBeTruthy();
  });

  it("opens the player from a video's title", async () => {
    renderConsole("#/theater");
    fireEvent.click(await screen.findByText("kiln-sample.webm"));
    await waitFor(() => expect(window.location.hash).toBe(`#/theater/${WITHOUT_CAPTIONS}`));
  });
});

describe("the theater player", () => {
  it("adds a default captions track only when the video has captions", async () => {
    renderConsole(`#/theater/${WITH_CAPTIONS}`);
    const track = (await screen.findByTestId("theater-video")).querySelector("track");
    expect(track?.hasAttribute("default")).toBe(true);
    expect(track?.getAttribute("src")).toBe(`/media/videos/${WITH_CAPTIONS}/captions`);
    cleanup();
    renderConsole(`#/theater/${WITHOUT_CAPTIONS}`);
    expect((await screen.findByTestId("theater-video")).querySelector("track")).toBeNull();
  });

  it("lists notes by time, and tapping one seeks the video to it", async () => {
    renderConsole(`#/theater/${WITH_CAPTIONS}`);
    const element = await screen.findByTestId<HTMLVideoElement>("theater-video");
    metadataLoaded(element);
    const rows = await screen.findAllByTestId(/^theater-note-/);
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual(["theater-note-00000000000000a1", "theater-note-00000000000000a2"]);
    fireEvent.click(within(rows[1]!).getByText("0:42"));
    expect(element.currentTime).toBe(42.5);
  });

  it("labels and dims a note made on an earlier render", async () => {
    renderConsole(`#/theater/${WITH_CAPTIONS}`);
    const earlier = await screen.findByTestId("theater-note-00000000000000a1");
    expect(within(earlier).getByText("earlier render")).toBeTruthy();
    expect(earlier.className).toContain("opacity-60");
    expect(within(screen.getByTestId("theater-note-00000000000000a2")).queryByText("earlier render")).toBeNull();
  });

  it("opens paused at ?t= once the metadata has loaded", async () => {
    renderConsole(`#/theater/${WITH_CAPTIONS}?t=95.5`);
    const element = await screen.findByTestId<HTMLVideoElement>("theater-video");
    expect(element.currentTime).toBe(0);
    metadataLoaded(element);
    expect(element.currentTime).toBe(95.5);
    expect(element.paused).toBe(true);
  });

  it("reads only a non-negative number from ?t=", () => {
    expect(startTimeOf("t=12")).toBe(12);
    expect(startTimeOf("tab=notes&t=3.5")).toBe(3.5);
    for (const query of [undefined, "", "t=", "t=-4", "t=abc", "t=Infinity"]) expect(startTimeOf(query)).toBeNull();
  });
});
