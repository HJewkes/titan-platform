import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../beat-slots.js";
import type { ExplainerFact } from "../presets/repo-explainer/schemas.js";
import { gatherReview } from "../presets/repo-explainer/gather.js";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import { ResolvedSchema } from "../resolve-stage.js";
import { runVideo } from "./host.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, SPINE, type Fixture } from "./run-fakes.test-helpers.js";

const FIXTURE = fileURLToPath(new URL("../../fixtures/review-whiteboard", import.meta.url));
const PIN = "2ddf3eb6c13d97b1d04a932c21de9a92029adaf9";

let fx: Fixture;
afterEach(() => fx.cleanup());

async function gatheredFacts(): Promise<ExplainerFact[]> {
  const result = await gatherReview({ reviewDir: FIXTURE, clonePath: "/clone/whiteboard", readHead: async () => PIN });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.facts;
}

async function whiteboardFacts(dir: string): Promise<string> {
  const file = path.join(dir, "facts.jsonl");
  writeFileSync(file, `${(await gatheredFacts()).map((fact) => JSON.stringify(fact)).join("\n")}\n`);
  return file;
}

/** The fixture spine with its one journey step renamed to a tour block, so chapter one opens the features section. */
function featuresSpine(dir: string): string {
  const file = path.join(dir, "features-spine.md");
  writeFileSync(file, SPINE.replace("| 1 | Scan |", "| 1 | features |"));
  return file;
}

/** The parcel-desk script with its first beat a companion-link card that cites one gathered feature fact. */
function scriptWithCard(feature: string) {
  const visual = { assertion: "The rest of the topic lives in the companion doc", job: "numbers", beat: "companion-link" };
  return choppy({ h1: { spoken: "The rest lives in the companion doc.", visual, fact_ids: [feature] } });
}

/** The theater file and anchor an exported href points at, as a reader beside the video would follow it. */
function follow(href: string): { file: string; anchor: string } {
  const [file, anchor] = href.split("#");
  return { file: path.join(fx.theater, file!), anchor: anchor! };
}

const artifact = (sha: string): string => readFileSync(path.join(fx.dataDir, "artifacts", sha), "utf8");

describe("the script stage's companion doc", () => {
  it("writes companion.md and the chapter links as artifacts of a run on gathered review facts", async () => {
    fx = fixture();
    const facts = await whiteboardFacts(fx.dataDir);

    const result = await runVideo({ spine: fx.spine, facts, to: "script" }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    const outputs = result.report.rows.find((row) => row.stage === "script")!.outputs;
    const links = JSON.parse(artifact(outputs["chapter-links"]!));
    expect(links).toMatchObject({ schema: "explainer.chapter-links/v1", doc: "companion.md", docSha: outputs.companion });
    expect(artifact(outputs.companion!)).toContain("## Contents");
    const chapters = JSON.parse(artifact(outputs.draft!)).chapters.map((chapter: { id: string }) => chapter.id);
    expect(links.links.map((link: { chapter: string }) => link.chapter)).toEqual(chapters);
  });

  it("writes no companion for a run whose facts are not gathered review facts", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, to: "script" }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(Object.keys(result.report.rows.find((row) => row.stage === "script")!.outputs)).toEqual(["draft"]);
  });
});

describe("companion links through export", () => {
  it("fills the card's link at resolve and exports companion.md beside the video, where the anchor exists", async () => {
    fx = fixture();
    const feature = (await gatheredFacts()).find((fact) => fact.kind === "feature")!.id;
    const facts = await whiteboardFacts(fx.dataDir);
    const model = fakeScriptModel(scriptWithCard(feature));

    const result = await runVideo({ spine: featuresSpine(fx.dataDir), facts }, fakeHost(fx, model, fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    const resolved = ResolvedSchema.parse(JSON.parse(artifact(result.report.rows.find((row) => row.stage === "resolve")!.outputs.resolved!)));
    const card = resolved.beats.find((beat) => beat.id === "h1")!;
    expect(BEAT_SLOTS["companion-link"].parse(card.slots)).toEqual({ title: "Features", section: "features", href: "companion.md#features" });
    const target = follow(card.slots!.href!);
    expect(target.file).toBe(path.join(fx.theater, "companion.md"));
    const doc = readFileSync(target.file, "utf8");
    expect(doc).toContain(`<a id="${target.anchor}"></a>`);
    const links = JSON.parse(artifact(result.report.rows.find((row) => row.stage === "script")!.outputs["chapter-links"]!));
    const factHref = links.links.find((link: { chapter: string }) => link.chapter === "ch1").facts[0].href;
    expect(doc).toContain(`<a id="${follow(factHref).anchor}"></a>**${feature}**`);
  });

  it("exports the companion as companion.md even when the host names it with the video's stem", async () => {
    fx = fixture();
    const bridgeFile = path.join(fx.dataDir, "bridge.json");
    const bridge = JSON.parse(readFileSync(bridgeFile, "utf8"));
    bridge.theater.files.companion = ".companion.md";
    writeFileSync(bridgeFile, JSON.stringify(bridge));
    const facts = await whiteboardFacts(fx.dataDir);

    const result = await runVideo({ spine: fx.spine, facts }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(readdirSync(fx.theater).sort()).toEqual(["companion.md", "demo.mp4", "demo.vtt"]);
  });

  it("exports no companion doc for a run whose facts are not gathered review facts", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(readdirSync(fx.theater).sort()).toEqual(["demo.mp4", "demo.vtt"]);
  });
});
