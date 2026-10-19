import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { createConsoleRegistry } from "./registry.js";
import type { ConsoleContext } from "./owner-guard.js";
import { getReview, listReviews, newReviewFileCache, reviewsCommands, type ReviewSummary, type ReviewsList } from "./reviews.js";
import { createSources } from "./upstreams.js";

const TOPICS_HEADER = "topic_id\ttier\ttitle\tverdict\tpriority\ttitan_evidence\treason\trepo_evidence";
const CLAIMS_HEADER = "id\tsource\tstatus\tevidence\tbasis\tclaim\tnote";
const RUNS_HEADER = "ts\tstage\ttotal_cost_usd\tis_error";
const IN_PROCESS: ConsoleContext = { warnings: [], format: "json", surface: "in-process", auth: null, ownerWrites: false };
const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-reviews-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, text: string): Promise<void> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

const topics = (...priorities: string[]): string =>
  [TOPICS_HEADER, ...priorities.map((priority, i) => `WID-CORE-${i + 1}\tcore\tTopic ${i + 1}\tmissing\t${priority}\tnone\tinvented\tsrc/a.ts`)].join("\n");

const claims = (count: number): string =>
  [CLAIMS_HEADER, ...Array.from({ length: count }, (_, i) => `C${i + 1}\tdocs/README.md\tverified\tsrc/a.ts:1\tread\tAn invented claim\t`)].join("\n");

const runs = (...rows: [string, string][]): string => [RUNS_HEADER, ...rows.map(([ts, usd]) => `${ts}\tread\t${usd}\tfalse`), ""].join("\n");

const readme = (remote: string, status: string): string => `# Review\n\n- Remote: ${remote}\n- HEAD: ${FULL_SHA} (2026-01-02)\n- status: ${status}\n`;

const summary = (unread: number | null): string =>
  `# Summary\n\n${unread === null ? "" : `- coverage: \`repo=x tracked=10 unread=${unread}\`\n`}\nInvented findings.\n`;

/** Three synthetic reviews (labelled final, wave1 and flat), a partial with no SUMMARY, and a tools/ dir with no README. */
async function plantReviews(): Promise<void> {
  await put("widget/README.md", readme("https://github.com/acme/widget", "pinned; skim next"));
  await put("widget/SUMMARY.md", summary(0));
  await put("widget/synthesis/current-label", "final\n");
  await put("widget/synthesis/final/topics-judged.tsv", topics("P1", "P1", "P2", "P3"));
  await put("widget/synthesis/final/claims-audit.tsv", claims(2));
  await put("widget/runs.tsv", runs(["2026-01-03T10:00:00Z", "1.25"], ["2026-01-04T10:00:00Z", "2.5"]));

  await put("gadget/README.md", "# Review\n\n- remote: https://github.com/acme/gadget\n");
  await put("gadget/SUMMARY.md", summary(3));
  await put("gadget/synthesis/current-label", "wave1");
  await put("gadget/synthesis/wave1/topics-judged.tsv", topics("P1", "P2", "P2", "P4"));
  await put("gadget/synthesis/final/topics-judged.tsv", topics("P1", "P1", "P1", "P1"));
  await put("gadget/runs.tsv", runs(["2026-01-05T10:00:00Z", "0.5"]));

  await put("sprocket/README.md", readme("https://github.com/acme/sprocket", "final"));
  await put("sprocket/SUMMARY.md", summary(null));
  await put("sprocket/synthesis/topics-judged.tsv", topics("P2", "P3"));
  await put("sprocket/synthesis/claims-audit.tsv", claims(1));

  await put("gizmo-design/README.md", readme("https://github.com/acme/gizmo", "harvesting"));
  await put("gizmo-design/wave1-state.json", "{}");
  await put("gizmo-design/synthesis/harvest-gd/notes.md", "invented");

  await put("tools/coverage.sh", "#!/bin/sh\n");
}

const byName = (list: ReviewsList, name: string): ReviewSummary | undefined => list.reviews.find((review) => review.name === name);

describe("reviews.list over a review folder tree", () => {
  it("counts P1 and P2 from the current label's topics and derives each review's state", async () => {
    await plantReviews();

    const list = await listReviews({ dir: root });

    const rows = list.reviews.map(({ name, label, state, p1, p2, topics: count }) => ({ name, label, state, p1, p2, topics: count }));
    expect(rows).toEqual([
      { name: "gadget", label: "wave1", state: "summarized", p1: 1, p2: 2, topics: 4 },
      { name: "widget", label: "final", state: "final", p1: 2, p2: 1, topics: 4 },
      { name: "gizmo-design", label: "flat", state: "reading", p1: 0, p2: 0, topics: 0 },
      { name: "sprocket", label: "flat", state: "summarized", p1: 0, p2: 1, topics: 2 },
    ]);
    expect(list.gaps).toEqual([]);
  });

  it("reads the pin, claims, coverage and headless cost of a review", async () => {
    await plantReviews();

    const widget = byName(await listReviews({ dir: root }), "widget");

    expect(widget).toMatchObject({ remote: "https://github.com/acme/widget", head: FULL_SHA, claims: 2, unread: 0 });
    expect(widget?.cost).toEqual({ usd: 3.75, calls: 2, errors: 0, lastTs: "2026-01-04T10:00:00Z" });
  });

  it("does not list a dir with no README.md", async () => {
    await plantReviews();

    const list = await listReviews({ dir: root });

    expect(list.reviews.map((review) => review.name)).not.toContain("tools");
  });

  it("reads final from the artifacts when the README still says pinned", async () => {
    await plantReviews();

    const widget = byName(await listReviews({ dir: root }), "widget");

    expect(widget).toMatchObject({ state: "final", readmeStatus: "pinned; skim next" });
  });

  it("turns a current-label of ../x into a gap and reads nothing outside synthesis/", async () => {
    await put("climber/README.md", readme("https://github.com/acme/climber", "pinned"));
    await put("climber/synthesis/current-label", "../x\n");
    await put("climber/x/topics-judged.tsv", topics("P1", "P1"));

    const list = await listReviews({ dir: root });

    expect(byName(list, "climber")).toMatchObject({ label: null, p1: 0, topics: 0 });
    expect(list.gaps).toEqual(["climber: synthesis/current-label is not a plain name; its TSVs were not read"]);
  });

  it("refuses a symlinked SUMMARY.md", async () => {
    await put("outside/SUMMARY.md", summary(0));
    await put("linked/README.md", readme("https://github.com/acme/linked", "pinned"));
    await put("linked/synthesis/current-label", "final");
    await put("linked/synthesis/final/topics-judged.tsv", topics("P1"));
    await symlink(path.join(root, "outside", "SUMMARY.md"), path.join(root, "linked", "SUMMARY.md"));

    const list = await listReviews({ dir: root });

    expect(byName(list, "linked")).toMatchObject({ state: "pinned", unread: null });
    expect(list.gaps).toEqual(["linked: SUMMARY.md is a symlink, not read"]);
  });

  it("refuses a symlinked synthesis dir", async () => {
    await put("elsewhere/current-label", "final");
    await put("elsewhere/final/topics-judged.tsv", topics("P1"));
    await put("hopper/README.md", readme("https://github.com/acme/hopper", "pinned"));
    await symlink(path.join(root, "elsewhere"), path.join(root, "hopper", "synthesis"));

    const hopper = byName(await listReviews({ dir: root }), "hopper");

    expect(hopper).toMatchObject({ label: null, p1: 0 });
  });

  it("keeps a review whose topics header lacks a column, with a gap naming the file", async () => {
    await put("broken/README.md", readme("https://github.com/acme/broken", "pinned"));
    await put("broken/SUMMARY.md", summary(0));
    await put("broken/synthesis/topics-judged.tsv", "topic_id\ttitle\nWID-1\tA topic\n");

    const list = await listReviews({ dir: root });

    expect(byName(list, "broken")).toMatchObject({ state: "summarized", topics: 0 });
    expect(list.gaps).toEqual(["broken: synthesis/topics-judged.tsv: header lacks tier, verdict, priority, titan_evidence, reason"]);
  });

  it("re-reads a file whose size changed since the cached read", async () => {
    await plantReviews();
    const cache = newReviewFileCache();
    await listReviews({ dir: root }, cache);
    await put("widget/synthesis/final/topics-judged.tsv", topics("P1", "P1", "P1", "P2", "P3"));

    const widget = byName(await listReviews({ dir: root }, cache), "widget");

    expect(widget).toMatchObject({ p1: 3, topics: 5 });
  });

  it("answers a missing reviews dir with one gap and no reviews", async () => {
    const list = await listReviews({ dir: path.join(root, "absent") });

    expect(list).toMatchObject({ reviews: [], gaps: ["the reviews dir does not exist"] });
  });

  it("serves reviews.list from the dir TITAN_CONSOLE_REVIEWS_DIR names", async () => {
    await plantReviews();
    const config = resolveConfig({ TITAN_CONSOLE_STATE: path.join(root, "state"), TITAN_CONSOLE_REVIEWS_DIR: root }, root, "linux");
    const sources = createSources(config);

    const list = await reviewsCommands({ dir: sources.reviews?.dir ?? "" })["reviews.list"].run({}, IN_PROCESS);

    expect(createConsoleRegistry(sources).get("reviews.list")).toBeDefined();
    expect(list.reviews.map((review) => review.name)).toEqual(["gadget", "widget", "gizmo-design", "sprocket"]);
  });
});

const RECOMMENDED = "# Summary\n\n- coverage: `repo=x tracked=10 unread=0`\n\n## Integration recommendations\n\n- **A1.** Adopt the invented cache.\n- Port the invented parser.\n\n## Appendix\n";

describe("reviews.get for one review", () => {
  it("returns the summary, coverage line, recommendations, every topic row and the claims rows", async () => {
    await plantReviews();
    await put("widget/SUMMARY.md", RECOMMENDED);

    const detail = await getReview({ dir: root }, "widget");

    expect(detail.summary).toEqual({ markdown: RECOMMENDED, truncated: false, bytes: RECOMMENDED.length });
    expect(detail.coverage).toBe("- coverage: `repo=x tracked=10 unread=0`");
    expect(detail.recommendations?.map((item) => item.id)).toEqual(["A1", "R2"]);
    expect(detail.topics.map((row) => row.priority)).toEqual(["P1", "P1", "P2", "P3"]);
    expect(detail.topics[0]).toMatchObject({ topic_id: "WID-CORE-1", extra: { repo_evidence: "src/a.ts" } });
    expect(detail.claims.map((row) => row.id)).toEqual(["C1", "C2"]);
    expect(detail.review).toMatchObject({ name: "widget", state: "final", p1: 2 });
    expect(detail.gaps).toEqual([]);
  });

  it("returns the rows and one gap line for a SUMMARY with no recommendations heading", async () => {
    await plantReviews();

    const detail = await getReview({ dir: root }, "widget");

    expect(detail.recommendations).toBeNull();
    expect(detail.topics).toHaveLength(4);
    expect(detail.claims).toHaveLength(2);
    expect(detail.gaps).toEqual(["SUMMARY.md has no Integration recommendations heading"]);
  });

  it("truncates a 300 KB SUMMARY at 256 KB and still reads its coverage line", async () => {
    await plantReviews();
    const big = `${RECOMMENDED}${"Invented prose line.\n".repeat(15_000)}`;
    await put("widget/SUMMARY.md", big);

    const detail = await getReview({ dir: root }, "widget");

    expect(detail.summary).toMatchObject({ truncated: true, bytes: big.length });
    expect(detail.summary?.markdown).toHaveLength(256 * 1024);
    expect(detail.coverage).toContain("unread=0");
  });

  it("refuses an unknown name with NOT FOUND and echoes no path", async () => {
    await plantReviews();

    const refusal = getReview({ dir: root }, "nonesuch");

    await expect(refusal).rejects.toThrow(/^NOT FOUND: no review by that name$/);
  });

  it("refuses a ../ name even when a review folder sits there", async () => {
    await put("outside/README.md", readme("https://github.com/acme/outside", "pinned"));
    await put("outside/SUMMARY.md", summary(0));
    await put("reviews/widget/README.md", readme("https://github.com/acme/widget", "pinned"));

    const refusal = getReview({ dir: path.join(root, "reviews") }, "../outside");

    await expect(refusal).rejects.toThrow(/^NOT FOUND: no review by that name$/);
  });

  it("refuses a dir with no README.md as not a review", async () => {
    await plantReviews();

    await expect(getReview({ dir: root }, "tools")).rejects.toThrow("NOT FOUND");
  });

  it("serves reviews.get as a read command", async () => {
    await plantReviews();
    const commands = reviewsCommands({ dir: root });

    const detail = await commands["reviews.get"].run({ name: "gadget" }, IN_PROCESS);

    expect(commands["reviews.get"].commandClass).toBe("read");
    expect(detail.review).toMatchObject({ name: "gadget", label: "wave1", p2: 2 });
  });
});
