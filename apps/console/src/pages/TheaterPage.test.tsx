// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { App } from "../App.js";
import { ROOTS_UNSET } from "../../server/videos.js";
import { startTimeOf } from "./TheaterPlayer.js";
import { DayFeedSection } from "./TheaterFeed.js";
import { dayKeyOf, feedStateOf, groupByDay, purposeOf, type VideoRow } from "./theater-feed.js";

afterEach(cleanup);

const WITH_CAPTIONS = "v_0123456789abcdef0123";
const WITHOUT_CAPTIONS = "v_fedcba9876543210fedc";
const SHA_NOW = "a".repeat(64);
const SHA_BEFORE = "b".repeat(64);

const OLD_TAKE = "v_00000000000000000old";
const CLIP = "v_0000000000000000clip";

function video(id: string, title: string, group: string, captions: boolean, modifiedAt: string, extra: Partial<VideoRow> = {}): VideoRow {
  return {
    id, title, group, bytes: 5_500_000, modifiedAt, captions, renderNotes: false, noteCount: 0, openNoteCount: 0, verdict: null,
    durationS: 125, width: 1920, height: 1080, orientation: "landscape", audio: true, copies: 0, superseded: false, ...extra,
  };
}

const VIDEOS = [
  { ...video(WITH_CAPTIONS, "lantern-explainer.mp4", "orbit/render", true, "2031-03-05T10:00:00.000Z", { purpose: "plan", copies: 2 }), noteCount: 1, verdict: "needs-changes" as const },
  video(WITHOUT_CAPTIONS, "kiln-sample.webm", "kiln", false, "2031-03-04T10:00:00.000Z", { purpose: "repo-review", orientation: "portrait" }),
  video(OLD_TAKE, "kiln-sample (v1)", "kiln", false, "2031-03-04T09:00:00.000Z", { purpose: "repo-review", superseded: true }),
  video(CLIP, "kiln sting", "kiln/clips", false, "2031-03-04T08:00:00.000Z", { durationS: 4 }),
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
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-03-05T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  const dayOf = (iso: string) => `theater-day-${dayKeyOf(iso)}`;

  it("shows the gap line when no roots are set", async () => {
    renderConsole("#/theater", snapshotOf({ videos: [], truncated: false, gaps: [ROOTS_UNSET] }));
    expect((await screen.findByTestId("theater-gap")).textContent).toContain(ROOTS_UNSET);
    expect(screen.getByText("No videos yet")).toBeTruthy();
  });

  it("sections videos by day, newest first, with purpose, flag, verdict and note pills", async () => {
    renderConsole("#/theater");
    await screen.findByTestId(dayOf(VIDEOS[0]!.modifiedAt));
    const days = screen.getAllByTestId(/^theater-day-/).map((day) => day.getAttribute("data-testid"));
    expect(days).toEqual([...new Set(VIDEOS.map((row) => dayOf(row.modifiedAt)))]);
    const card = screen.getByTestId(`theater-video-${WITH_CAPTIONS}`);
    for (const text of ["Plan", "Needs changes", "1 note"]) expect(within(card).getByText(text)).toBeTruthy();
    expect(within(screen.getByTestId(`theater-video-${WITHOUT_CAPTIONS}`)).getByText("Phone")).toBeTruthy();
  });

  it("hides old takes and clips by default, and points at both", async () => {
    renderConsole("#/theater");
    await screen.findByTestId(`theater-video-${WITHOUT_CAPTIONS}`);
    expect(screen.queryByTestId(`theater-video-${OLD_TAKE}`)).toBeNull();
    expect(screen.queryByTestId(`theater-video-${CLIP}`)).toBeNull();
    expect(screen.getByText("2 copies folded")).toBeTruthy();
    fireEvent.click(screen.getByText("1 clip"));
    await waitFor(() => expect(window.location.hash).toBe("#/theater?tag=clip"));
    expect(await screen.findByTestId(`theater-video-${CLIP}`)).toBeTruthy();
  });

  it("shows old takes behind ?old=1, flagged", async () => {
    renderConsole("#/theater?old=1");
    expect(within(await screen.findByTestId(`theater-video-${OLD_TAKE}`)).getByText("Old take")).toBeTruthy();
  });

  it("filters by a purpose chip into ?tag=, and counts each purpose", async () => {
    renderConsole("#/theater");
    fireEvent.click(await screen.findByText("Repo review 1"));
    await waitFor(() => expect(window.location.hash).toBe("#/theater?tag=repo-review"));
    await waitFor(() => expect(screen.queryByTestId(`theater-video-${WITH_CAPTIONS}`)).toBeNull());
    expect(screen.getByTestId(`theater-video-${WITHOUT_CAPTIONS}`)).toBeTruthy();
  });

  it("searches into ?q= and bolds the match", async () => {
    renderConsole("#/theater");
    fireEvent.change(await screen.findByLabelText("Search videos"), { target: { value: "lantern" } });
    await waitFor(() => expect(window.location.hash).toBe("#/theater?q=lantern"));
    await waitFor(() => expect(screen.queryByTestId(`theater-video-${WITHOUT_CAPTIONS}`)).toBeNull());
    expect(within(screen.getByTestId(`theater-video-${WITH_CAPTIONS}`)).getByTestId("theater-match").textContent).toBe("lantern");
  });

  it("offers Clear when nothing matches", async () => {
    renderConsole("#/theater?q=zzz&tag=plan");
    expect(await screen.findByText("No matches")).toBeTruthy();
    expect(screen.getByText("“zzz” in Plan")).toBeTruthy();
    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => expect(window.location.hash).toBe("#/theater"));
  });

  it("opens the player from a video's title", async () => {
    renderConsole("#/theater");
    fireEvent.click(await screen.findByText("kiln-sample.webm"));
    await waitFor(() => expect(window.location.hash).toBe(`#/theater/${WITHOUT_CAPTIONS}`));
  });
});

describe("a day section", () => {
  it("names the day, counts its videos and run time, and links its hidden clips", () => {
    const rows = VIDEOS.map((entry) => ({ video: entry, purpose: purposeOf(entry) }));
    const [day] = groupByDay(rows.slice(1, 2), rows.slice(3), { now: new Date("2031-03-05T12:00:00.000Z"), timeZone: "UTC" });
    render(<DayFeedSection section={day!} state={feedStateOf("")} />);
    expect(screen.getByText("Yesterday")).toBeTruthy();
    expect(screen.getByText("Tue 4 Mar · 1 video, 2:05")).toBeTruthy();
    expect(screen.getByText("1 clip")).toBeTruthy();
    expect(screen.getByText("Repo review")).toBeTruthy();
    expect(screen.getByText("kiln · 2:05")).toBeTruthy();
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

  it("marks the current render's notes on the scrub strip once the duration is known", async () => {
    renderConsole(`#/theater/${WITH_CAPTIONS}`);
    const element = await screen.findByTestId<HTMLVideoElement>("theater-video");
    await screen.findAllByTestId(/^theater-note-/);
    Object.defineProperty(element, "duration", { configurable: true, value: 170 });
    fireEvent(element, new Event("durationchange"));
    expect((await screen.findByTestId("theater-marker-00000000000000a2")).style.left).toBe("25%");
    expect(screen.queryByTestId("theater-marker-00000000000000a1")).toBeNull();
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
