import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { paperPublishEligibility } from "./article-checks.js";
import { gatherArticle } from "./presets/article/gather-article.js";
import type { ArticleFact } from "./presets/article/schemas.js";
import { loadProfiles, profileFor } from "./profile-load.js";
import { StoryboardSchema, type Storyboard } from "./storyboard.js";

const DEMO = fileURLToPath(new URL("../fixtures/article/demo", import.meta.url));

let facts: ArticleFact[];
beforeAll(async () => {
  const claims = JSON.parse(readFileSync(join(DEMO, "claims.json"), "utf8")) as unknown[];
  ({ facts } = await gatherArticle({ articlePath: join(DEMO, "article.md"), label: "Fewer Rounds by Design", claims }));
});

const board = (): Storyboard => StoryboardSchema.parse(JSON.parse(readFileSync(join(DEMO, "beats.json"), "utf8")));

function edited(change: (beats: Storyboard["beats"]) => void): Storyboard {
  const next = board();
  change(next.beats);
  return next;
}

const LONG_QUOTE = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six";
const replotSeries = (beats: Storyboard["beats"]) => (beats[1]!.slots as { series: { points: { x: number; y: number }[] }[] }).series;

describe("paper publish eligibility", () => {
  it("makes a video eligible when every figure is re-plotted from its data and every quote is short, and still requires the owner's ask", () => {
    expect(paperPublishEligibility(board(), facts)).toEqual({ eligible: true, ownerAskRequired: true, issues: [] });
  });

  it("fails a beat that shows a figure as an image", () => {
    const video = edited((beats) => (beats[2]!.slots = { image: "assets/figure-2.PNG" }));

    const result = paperPublishEligibility(video, facts);

    expect(result.eligible).toBe(false);
    expect(result.issues).toEqual([{ check: "figures-replotted-from-data", beat: "beat-03", message: "beat-03 shows an image; a figure is re-plotted from data, never a picture of it" }]);
  });

  it("fails an inline data-url image nested deep in the slots", () => {
    const video = edited((beats) => (beats[2]!.slots = { cards: [{ id: "a", art: { src: "data:image/png;base64,AAAA" } }] }));

    expect(paperPublishEligibility(video, facts).issues.map((issue) => issue.beat)).toEqual(["beat-03"]);
  });

  it("fails a replot whose points are not the figure's data", () => {
    const video = edited((beats) => (replotSeries(beats)[1]!.points[2]!.y = 1.2));

    expect(paperPublishEligibility(video, facts).issues).toEqual([{ check: "figures-replotted-from-data", beat: "beat-02", message: "replot beat-02 plots points that are not figure/figure-1's data" }]);
  });

  it("fails a replot that drops a point, and a replot with no series", () => {
    const dropped = edited((beats) => replotSeries(beats)[0]!.points.pop());
    const empty = edited((beats) => ((beats[1]!.slots as { series: unknown[] }).series = []));

    expect(paperPublishEligibility(dropped, facts).eligible).toBe(false);
    expect(paperPublishEligibility(empty, facts).eligible).toBe(false);
  });

  it("fails a replot citing a source that is not a gathered figure", () => {
    const video = edited((beats) => ((beats[1]!.slots as { source: { ref: string } }).source.ref = "number/rounds-after"));

    expect(paperPublishEligibility(video, facts).issues[0]?.message).toBe("replot beat-02 cites no gathered figure; its source.ref must name a figure fact id");
  });

  it("fails a non-replot beat that shows a gathered figure", () => {
    const video = edited((beats) => beats[2]!.sources.push("figure/table-2"));

    expect(paperPublishEligibility(video, facts).issues[0]?.message).toBe("beat-03 shows figure/table-2 as a stat beat; a figure is shown only as a replot of its data");
  });

  it("fails a slot quote over the length limit", () => {
    const video = edited((beats) => ((beats[0]!.slots as { quote: { text: string } }).quote.text = LONG_QUOTE));

    expect(paperPublishEligibility(video, facts).issues).toEqual([{ check: "quotes-short", beat: "beat-01", message: "beat-01 quotes 26 words; the limit is 25" }]);
  });

  it("fails a plain-string quote slot and a quote read out in the narration or shown on screen", () => {
    const video = edited((beats) => {
      beats[0]!.slots = { claim: "c", quote: LONG_QUOTE };
      beats[1]!.spoken = `They wrote “${LONG_QUOTE}” in the paper.`;
      beats[2]!.display = `"${LONG_QUOTE}"`;
    });

    expect(paperPublishEligibility(video, facts).issues.map((issue) => [issue.check, issue.beat])).toEqual([
      ["quotes-short", "beat-01"],
      ["quotes-short", "beat-02"],
      ["quotes-short", "beat-03"],
    ]);
  });

  it("allows a quote of exactly the limit, and applies a tighter limit when given one", () => {
    const limit = LONG_QUOTE.split(" ").slice(0, 25).join(" ");
    const video = edited((beats) => ((beats[0]!.slots as { quote: { text: string } }).quote.text = limit));

    expect(paperPublishEligibility(video, facts).eligible).toBe(true);
    expect(paperPublishEligibility(board(), facts, undefined, 10).issues.map((issue) => issue.beat)).toEqual(["beat-01"]);
  });

  it("implements every publish check the paper-summary profile names", () => {
    const checks = profileFor(loadProfiles(), "paper-summary").publish?.checks ?? [];
    const video = edited((beats) => (beats[2]!.slots = { image: "figure.png" }));

    expect(paperPublishEligibility(board(), facts, checks).eligible).toBe(true);
    expect(paperPublishEligibility(video, facts, checks).eligible).toBe(false);
  });

  it("runs only the checks the profile names", () => {
    const video = edited((beats) => (beats[2]!.slots = { image: "figure.png" }));

    expect(paperPublishEligibility(video, facts, ["quotes-short"]).eligible).toBe(true);
  });

  it("fails a video on a check it does not implement, and on a profile naming no checks", () => {
    expect(paperPublishEligibility(board(), facts, ["quotes-short", "licence-cleared"]).issues).toEqual([{ check: "licence-cleared", message: "publish check licence-cleared is not implemented; the video is not eligible" }]);
    expect(paperPublishEligibility(board(), facts, []).eligible).toBe(false);
  });
});
