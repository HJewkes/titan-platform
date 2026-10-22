import { describe, expect, it } from "vitest";
import {
  dayKeyOf,
  dayLabel,
  feedQuery,
  feedStateOf,
  formatRunTime,
  groupByDay,
  purposeCounts,
  purposeOf,
  searchedRows,
  sectionSubtitle,
  shownRows,
  splitMatches,
  type FeedRow,
  type VideoRow,
} from "./theater-feed.js";

function video(id: string, modifiedAt: string, extra: Partial<VideoRow> = {}): VideoRow {
  return {
    id,
    title: `Render ${id}`,
    group: "studio/out",
    bytes: 1_000_000,
    modifiedAt,
    captions: false,
    renderNotes: false,
    durationS: 60,
    width: 1920,
    height: 1080,
    orientation: "landscape",
    audio: true,
    copies: 0,
    superseded: false,
    noteCount: 0,
    openNoteCount: 0,
    verdict: null,
    ...extra,
  };
}

const rowOf = (entry: VideoRow): FeedRow => ({ video: entry, purpose: purposeOf(entry) });
const NO_STATE = { q: "", purpose: null, old: false };

describe("purposeOf", () => {
  it("takes the sidecar purpose over every guess", () => {
    expect(purposeOf(video("a", "2031-03-05T10:00:00Z", { purpose: "plan", durationS: 3, series: "daily-digest", tags: ["design"] }))).toBe("plan");
  });

  it("falls back to a tag naming a purpose, then length, then subject and series", () => {
    expect(purposeOf(video("a", "", { tags: ["wip", "explainer"] }))).toBe("explainer");
    expect(purposeOf(video("a", "", { durationS: 4, series: "daily-digest" }))).toBe("clip");
    expect(purposeOf(video("a", "", { subject: { kind: "repo", id: "widget-kit" } }))).toBe("repo-review");
    expect(purposeOf(video("a", "", { series: "repo-review-widget" }))).toBe("repo-review");
    expect(purposeOf(video("a", "", { series: "day-recap" }))).toBe("daily");
    expect(purposeOf(video("a", "", { subject: { kind: "day", id: "2031-03-05" } }))).toBe("daily");
  });

  it("calls a render with nothing to go on other, even when its length is unknown", () => {
    expect(purposeOf(video("a", "", { durationS: null }))).toBe("other");
  });
});

describe("the feed's query string", () => {
  it("round-trips search, purpose and old takes", () => {
    const state = { q: "lantern intro", purpose: "repo-review" as const, old: true };
    expect(feedQuery(state)).toBe("tag=repo-review&q=lantern+intro&old=1");
    expect(feedStateOf(feedQuery(state))).toEqual(state);
  });

  it("drops an unknown tag and writes nothing for the default feed", () => {
    expect(feedStateOf("tag=bogus&old=yes")).toEqual(NO_STATE);
    expect(feedStateOf(undefined)).toEqual(NO_STATE);
    expect(feedQuery(NO_STATE)).toBe("");
  });
});

describe("which rows the feed shows", () => {
  const VIDEOS = [
    video("long", "2031-03-05T10:00:00Z", { title: "Lantern walkthrough", purpose: "explainer" }),
    video("old", "2031-03-04T10:00:00Z", { title: "Lantern walkthrough (v1)", purpose: "explainer", superseded: true }),
    video("clip", "2031-03-04T09:00:00Z", { title: "Lantern sting", durationS: 5 }),
  ];

  it("hides old takes and clips until asked, but counts clips for their chip", () => {
    const searched = searchedRows(VIDEOS, NO_STATE);
    expect(shownRows(searched, NO_STATE).map((row) => row.video.id)).toEqual(["long"]);
    expect(purposeCounts(searched).clip).toBe(1);
    expect(shownRows(searchedRows(VIDEOS, { ...NO_STATE, old: true }), NO_STATE).map((row) => row.video.id)).toEqual(["long", "old"]);
    expect(shownRows(searched, { ...NO_STATE, purpose: "clip" }).map((row) => row.video.id)).toEqual(["clip"]);
  });

  it("lets a search reach old takes and clips", () => {
    const state = { ...NO_STATE, q: "LANTERN" };
    expect(shownRows(searchedRows(VIDEOS, state), state).map((row) => row.video.id)).toEqual(["long", "old", "clip"]);
  });
});

describe("grouping by day", () => {
  // 2031-03-05 06:30 UTC is still the 4th in Los Angeles and already the 5th in Auckland.
  const NOW = new Date("2031-03-06T20:00:00Z");
  const EARLY = video("early", "2031-03-05T06:30:00Z", { durationS: 90 });
  const LATER = video("later", "2031-03-05T22:00:00Z", { durationS: 45.4 });

  it("buckets renders by the reader's timezone, newest day and render first", () => {
    const sections = groupByDay([EARLY, LATER].map(rowOf), [], { now: NOW, timeZone: "America/Los_Angeles" });
    expect(sections.map((section) => [section.key, section.name, section.rows.map((row) => row.video.id)])).toEqual([
      ["2031-03-05", "Yesterday", ["later"]],
      ["2031-03-04", "Tuesday", ["early"]],
    ]);
  });

  it("puts both on one day where the timezone does, and totals its run time", () => {
    const [section] = groupByDay([EARLY, LATER].map(rowOf), [], { now: NOW, timeZone: "UTC" });
    expect(section!.rows.map((row) => row.video.id)).toEqual(["later", "early"]);
    expect(sectionSubtitle(section!)).toBe("Wed 5 Mar · 2 videos, 2:15");
  });

  it("keeps a day that only holds hidden clips, with no video count", () => {
    const clip = rowOf(video("clip", "2031-03-01T12:00:00Z", { durationS: 4 }));
    const sections = groupByDay([rowOf(LATER)], [clip], { now: NOW, timeZone: "UTC" });
    expect(sections.map((section) => [section.key, section.hiddenClips])).toEqual([
      ["2031-03-05", 0],
      ["2031-03-01", 1],
    ]);
    expect(sectionSubtitle(sections[1]!)).toBe("1 Mar");
  });

  it("files a render with no readable time under Undated, last", () => {
    const sections = groupByDay([rowOf(LATER), rowOf(video("bad", "not a time"))], [], { now: NOW, timeZone: "UTC" });
    expect(sections.map((section) => section.name)).toEqual(["Yesterday", "Undated"]);
  });
});

describe("day names", () => {
  it("names today, yesterday, the rest of the week, then the date with its year", () => {
    expect(dayLabel("2031-03-05", "2031-03-05")).toEqual({ name: "Today", date: "Wed 5 Mar" });
    expect(dayLabel("2031-03-04", "2031-03-05")).toEqual({ name: "Yesterday", date: "Tue 4 Mar" });
    expect(dayLabel("2031-02-27", "2031-03-05")).toEqual({ name: "Thursday", date: "27 Feb" });
    expect(dayLabel("2031-02-26", "2031-03-05")).toEqual({ name: "26 Feb", date: "Wed 2031" });
  });

  it("reads the day in the given timezone", () => {
    expect(dayKeyOf("2031-03-05T06:30:00Z", "America/Los_Angeles")).toBe("2031-03-04");
    expect(dayKeyOf("2031-03-05T06:30:00Z", "Pacific/Auckland")).toBe("2031-03-05");
    expect(dayKeyOf("garbage")).toBeNull();
  });
});

describe("formatting", () => {
  it("prints run times as m:ss, and h:mm:ss from an hour", () => {
    expect(formatRunTime(4.4)).toBe("0:04");
    expect(formatRunTime(135)).toBe("2:15");
    expect(formatRunTime(3725)).toBe("1:02:05");
  });

  it("splits matched runs case-insensitively", () => {
    expect(splitMatches("Lantern and lantern", "LANTERN")).toEqual([
      { text: "Lantern", match: true },
      { text: " and ", match: false },
      { text: "lantern", match: true },
    ]);
    expect(splitMatches("Lantern", " ")).toEqual([{ text: "Lantern", match: false }]);
  });
});
