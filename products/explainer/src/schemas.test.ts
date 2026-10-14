import { describe, expect, it } from "vitest";
import { DigestSchema } from "./digest.js";
import { LexiconSchema, lexiconEntriesFor } from "./lexicon.js";
import { StoryboardSchema, beatNumber } from "./storyboard.js";

const board = (beats: unknown[], extra: Record<string, unknown> = {}) => ({
  video_type: "repo-tour",
  title: "A synthetic tour",
  chapters: [{ id: "context", title: "Context" }],
  beats,
  ...extra,
});

const beat = (fields: Record<string, unknown> = {}) => ({
  id: "beat-01",
  type: "chapter-open",
  duration_s: 6,
  spoken: "Where does a request enter?",
  ...fields,
});

describe("StoryboardSchema", () => {
  it("accepts a beat with a chapter and stops in seconds, and defaults slots and sources", () => {
    const parsed = StoryboardSchema.parse(board([beat({ chapter: "context", stops: [0, 1.5, 6] })]));

    expect(parsed.video_type).toBe("repo-tour");
    expect(parsed.beats[0]).toMatchObject({ chapter: "context", stops: [0, 1.5, 6], slots: {}, sources: [] });
  });

  it("rejects a chapter the storyboard does not declare", () => {
    expect(StoryboardSchema.safeParse(board([beat({ chapter: "verdict" })])).success).toBe(false);
  });

  it("rejects stops that do not ascend or run past the beat", () => {
    expect(StoryboardSchema.safeParse(board([beat({ stops: [2, 1] })])).success).toBe(false);
    expect(StoryboardSchema.safeParse(board([beat({ stops: [7] })])).success).toBe(false);
  });

  it("rejects two ids naming the same beat number", () => {
    expect(StoryboardSchema.safeParse(board([beat({ id: "beat-3" }), beat({ id: "beat-03" })])).success).toBe(false);
  });

  it("rejects a non-kebab video type and a malformed beat id", () => {
    expect(StoryboardSchema.safeParse(board([beat()], { video_type: "Repo Tour" })).success).toBe(false);
    expect(StoryboardSchema.safeParse(board([beat({ id: "intro" })])).success).toBe(false);
  });

  it("rejects an empty storyboard", () => {
    expect(StoryboardSchema.safeParse(board([])).success).toBe(false);
  });
});

describe("beatNumber", () => {
  it("reads the number a beat id names", () => {
    expect([beatNumber("beat-03"), beatNumber("beat-30"), beatNumber("beat-x")]).toEqual([3, 30, undefined]);
  });
});

describe("DigestSchema", () => {
  const item = (id: string) => ({ id, kind: "pull-request", title: "Add a parser", at: "2026-01-02T10:00:00Z" });

  it("accepts a window with items", () => {
    const digest = { since: "2026-01-01T00:00:00Z", until: "2026-01-03T00:00:00Z", items: [item("pr-1"), item("pr-2")] };

    expect(DigestSchema.parse(digest).items).toHaveLength(2);
  });

  it("rejects duplicate item ids and a window that ends before it starts", () => {
    const dup = { since: "2026-01-01T00:00:00Z", until: "2026-01-03T00:00:00Z", items: [item("pr-1"), item("pr-1")] };
    const backwards = { since: "2026-01-03T00:00:00Z", until: "2026-01-01T00:00:00Z", items: [] };

    expect(DigestSchema.safeParse(dup).success).toBe(false);
    expect(DigestSchema.safeParse(backwards).success).toBe(false);
  });
});

describe("lexiconEntriesFor", () => {
  const lexicon = LexiconSchema.parse({ entries: [{ term: "CI", spoken: "C I" }, { term: "C++", spoken: "C plus plus" }] });

  it("matches whole terms only, case-insensitively", () => {
    expect(lexiconEntriesFor(lexicon, ["the circle of ci"])).toEqual([{ term: "CI", spoken: "C I" }]);
    expect(lexiconEntriesFor(lexicon, ["CIRCLE"])).toEqual([]);
  });

  it("matches a term ending in punctuation", () => {
    expect(lexiconEntriesFor(lexicon, ["written in C++."])).toEqual([{ term: "C++", spoken: "C plus plus" }]);
  });
});
