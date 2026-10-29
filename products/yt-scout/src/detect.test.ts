import { chmodSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAtom } from "./atom.js";
import { runCli } from "./cli.js";
import { createDetector, detectNew, resolveYtDlp, type DetectDeps } from "./detect.js";
import { tempTree, VALID_WATCHLIST, type TempTree } from "./fixtures.test-helpers.js";
import { parseFlatListing } from "./flat-listing.js";
import { parseWatchlist } from "./watchlist.js";
import { openScoutDb } from "./store.js";
import type { StepRow } from "./rows.js";

const NOW = new Date("2026-10-29T10:00:00Z");

const atom = (entries: { id: string; title: string; link?: string }[]) =>
  `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">${entries
    .map(
      (e) =>
        `<entry><yt:videoId>${e.id}</yt:videoId><title>${e.title}</title><link rel="alternate" href="${e.link ?? `https://www.youtube.com/watch?v=${e.id}`}"/><published>2026-10-28T09:00:00+00:00</published></entry>`,
    )
    .join("")}</feed>`;

const listing = (entries: object[]) => JSON.stringify({ entries });

const ATOM = atom([
  { id: "vvvvvvvvv01", title: "Full talk &amp; demo" },
  { id: "sssssssss01", title: "Quick tip", link: "https://www.youtube.com/shorts/sssssssss01" },
]);

const LISTING = listing([
  { id: "lllllllll01", title: "Vod", duration: 1200, live_status: "not_live" },
  { id: "lllllllll02", title: "Soon", live_status: "is_upcoming" },
  { id: "lllllllll03", title: "Clip", duration: 30, live_status: "not_live" },
  { id: "lllllllll04", title: "Day long", duration: 90000, live_status: "not_live" },
  { id: "UCaaaaaaaaaaaaaaaaaaaaaa", title: "tab playlist" },
]);

function fakeDeps(over: Partial<DetectDeps> & { rows?: StepRow[] } = {}): DetectDeps {
  return {
    fetchText: async () => ({ status: 200, text: ATOM }),
    ytDlp: async () => LISTING,
    onRow: (r) => over.rows?.push(r),
    ...over,
  };
}

describe("parsers", () => {
  it("reads ids, titles, dates and marks a /shorts/ link as a short", () => {
    expect(parseAtom(ATOM)).toEqual([
      { id: "vvvvvvvvv01", title: "Full talk & demo", published: "2026-10-28T09:00:00+00:00", kind: "vod" },
      { id: "sssssssss01", title: "Quick tip", published: "2026-10-28T09:00:00+00:00", kind: "short" },
    ]);
  });

  it("classifies live_status and drops non-video ids", () => {
    expect(parseFlatListing(LISTING).map((e) => [e.id, e.kind])).toEqual([
      ["lllllllll01", "vod"],
      ["lllllllll02", "upcoming"],
      ["lllllllll03", "vod"],
      ["lllllllll04", "vod"],
    ]);
  });
});

describe("detector", () => {
  const watchlist = parseWatchlist(VALID_WATCHLIST, "w.yml");
  const channel = watchlist.sources[0]!;

  it("uses RSS without a fallback row when the feed answers", async () => {
    const rows: StepRow[] = [];
    const found = await createDetector(fakeDeps({ rows }), ["videos"]).detect(channel, NOW);

    expect(found.map((v) => v.id)).toEqual(["vvvvvvvvv01", "sssssssss01"]);
    expect(rows).toEqual([]);
  });

  it("falls back to the yt-dlp listing and writes a fallback row on RSS 404", async () => {
    const rows: StepRow[] = [];
    const calls: string[][] = [];
    const deps = fakeDeps({ rows, fetchText: async () => ({ status: 404, text: "" }), ytDlp: async (a) => (calls.push(a), LISTING) });

    const found = await createDetector(deps, ["videos"]).detect(channel, NOW);

    expect(found).toHaveLength(4);
    expect(calls[0]!.at(-1)).toBe("https://www.youtube.com/@confTalks/videos");
    expect(rows).toMatchObject([{ step: "detect", outcome: "fallback", error_class: "rss_404", source: "confTalks" }]);
  });

  it("falls back on an unparseable feed", async () => {
    const rows: StepRow[] = [];
    await createDetector(fakeDeps({ rows, fetchText: async () => ({ status: 200, text: "<html/>" }) }), ["videos"]).detect(channel, NOW);

    expect(rows[0]!.error_class).toBe("rss_parse");
  });

  it("drops search hits whose title and channel lack the name", async () => {
    const search = watchlist.sources[2]!;
    const deps = fakeDeps({
      ytDlp: async () =>
        listing([
          { id: "hhhhhhhhh01", title: "Jane Speaker on agents", channel: "Somewhere" },
          { id: "hhhhhhhhh02", title: "Unrelated", channel: "JANE SPEAKER Official" },
          { id: "hhhhhhhhh03", title: "Someone else entirely", channel: "Other" },
        ]),
    });

    const found = await createDetector(deps, ["videos"]).detect(search, NOW);

    expect(found.map((v) => v.id)).toEqual(["hhhhhhhhh01", "hhhhhhhhh02"]);
  });

  it("skips ids already in videos and attaches filtered states", async () => {
    const db = openScoutDb(":memory:");
    db.prepare("INSERT INTO videos (id, source, detected_at, state) VALUES ('vvvvvvvvv01', 'confTalks', ?, 'seen')").run(NOW.toISOString());
    const deps = fakeDeps({ fetchText: async () => ({ status: 404, text: "" }) });

    const found = await detectNew(db, { ...watchlist, sources: [channel] }, createDetector(deps, ["videos"]), NOW);

    expect(found.get("confTalks")!.map((v) => [v.id, v.state])).toEqual([
      ["lllllllll01", "new"],
      ["lllllllll02", "new"],
      ["lllllllll03", "skipped:short"],
      ["lllllllll04", "index_only"],
    ]);
    expect(found.get("confTalks")![1]!.next_retry_at).toBe("2026-10-29T16:00:00.000Z");
  });
});

describe("titan-yt-scout detect --dry-run", () => {
  let tree: TempTree;
  beforeEach(() => (tree = tempTree()));
  afterEach(() => tree.cleanup());

  it("lists new ids per source, inserts nothing and writes fallback rows on 404", async () => {
    tree.write("w.yml", VALID_WATCHLIST);
    const out: string[] = [];
    const db = path.join(tree.root, "s.sqlite3");
    const rowsDirPath = path.join(tree.root, "rows");
    const mk = (onRow: DetectDeps["onRow"], _bin?: string) => fakeDeps({ onRow, fetchText: async () => ({ status: 404, text: "" }) });

    const code = await runCli(["detect", "--dry-run", "--config", path.join(tree.root, "w.yml"), "--db", db, "--rows-dir", rowsDirPath], (l) => out.push(l), () => {}, mk);

    expect(code).toBe(0);
    expect(out).toContain("confTalks: 4 new");
    expect(out).toContain("rss fallbacks: 2");
    const file = readdirSync(rowsDirPath)[0]!;
    const lines = readFileSync(path.join(rowsDirPath, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.outcome)).toEqual(["fallback", "fallback"]);
    expect(openScoutDb(db).prepare("SELECT COUNT(*) AS n FROM videos").get()).toEqual({ n: 0 });
  });
});

describe("yt-dlp binary", () => {
  let tree: TempTree;
  beforeEach(() => (tree = tempTree()));
  afterEach(() => tree.cleanup());

  it("prefers the configured path over YT_DLP over PATH", () => {
    expect(resolveYtDlp("/opt/a", { YT_DLP: "/opt/b" })).toBe("/opt/a");
    expect(resolveYtDlp(undefined, { YT_DLP: "/opt/b" })).toBe("/opt/b");
    expect(resolveYtDlp(undefined, {})).toBe("yt-dlp");
  });

  it("invokes the binary named by the yt_dlp config key", async () => {
    const bin = path.join(tree.root, "fake-yt-dlp");
    tree.write("fake-yt-dlp", `#!/bin/sh\necho '{"entries":[{"id":"fakefakefk1","title":"Jane Speaker talk","duration":600}]}'\n`);
    chmodSync(bin, 0o755);
    const searchOnly = VALID_WATCHLIST.split("\n").filter((l) => !/^ {2}- key: (confTalks|vendor)|^ {4}(name: (Conference|Vendor)|channel_id|handle|poll: 6h|trial_until)/.test(l)).join("\n");
    tree.write("w.yml", `${searchOnly}yt_dlp: ${bin}\n`);
    const out: string[] = [];

    const code = await runCli(["detect", "--dry-run", "--config", path.join(tree.root, "w.yml"), "--db", path.join(tree.root, "s.sqlite3"), "--rows-dir", path.join(tree.root, "rows")], (l) => out.push(l));

    expect(code).toBe(0);
    expect(out).toContain("speaker: 1 new");
  });
});
