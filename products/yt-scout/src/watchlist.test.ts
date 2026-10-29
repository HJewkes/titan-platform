import { describe, expect, it } from "vitest";
import { isOnTrial } from "./config.js";
import { VALID_WATCHLIST } from "./fixtures.test-helpers.js";
import { parseWatchlist, WatchlistError } from "./watchlist.js";

function problemsOf(text: string): WatchlistError["problems"] {
  try {
    parseWatchlist(text, "watchlist.yml");
  } catch (err) {
    if (err instanceof WatchlistError) return err.problems;
    throw err;
  }
  throw new Error("expected the watch list to be refused");
}

describe("watch list", () => {
  it("accepts a valid file with channel, trial and search sources", () => {
    const w = parseWatchlist(VALID_WATCHLIST, "watchlist.yml");

    expect(w.sources.map((s) => s.key)).toEqual(["confTalks", "vendor", "speaker"]);
    expect(w.sources.filter((s) => isOnTrial(s, "2026-10-28")).map((s) => s.key)).toEqual(["vendor"]);
    expect(isOnTrial(w.sources[1], "2026-11-28")).toBe(false);
  });

  it("reports the line of a YAML syntax error", () => {
    const text = VALID_WATCHLIST.replace("    handle: confTalks\n", "    handle: confTalks: nested\n");

    const [problem] = problemsOf(text);

    expect(problem?.line).toBe(7);
    expect(problem?.path).toBe("");
  });

  it("refuses an unknown key on the key's own line", () => {
    const text = VALID_WATCHLIST.replace("    poll: 6h\n", "    poll: 6h\n    pol: 3h\n");

    expect(problemsOf(text)).toEqual([{ line: 12, path: "sources.1.pol", message: "unknown key" }]);
  });

  it("refuses an unknown top-level key", () => {
    expect(problemsOf(`${VALID_WATCHLIST}extra: true\n`)).toEqual([{ line: 21, path: "extra", message: "unknown key" }]);
  });

  it("points a bad value at its line", () => {
    const [problem] = problemsOf(VALID_WATCHLIST.replace("poll: 24h", "poll: daily"));

    expect(problem).toMatchObject({ line: 17, path: "sources.2.poll" });
  });

  it("refuses a source with both a channel and a search", () => {
    const text = VALID_WATCHLIST.replace("    poll: 24h\n", "    poll: 24h\n    channel_id: UCcccccccccccccccccccccc\n");

    expect(problemsOf(text)[0]).toMatchObject({ path: "sources.2", message: "a source needs exactly one of channel_id or search" });
  });

  it("refuses a duplicate source key", () => {
    const text = VALID_WATCHLIST.replace("key: vendor", "key: confTalks");

    expect(problemsOf(text)).toEqual([{ line: 8, path: "sources.1.key", message: 'duplicate source key "confTalks"' }]);
  });
});
