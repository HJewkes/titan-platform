import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { gatherReview } from "../presets/repo-explainer/gather.js";
import { runVideo } from "./host.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

const FIXTURE = fileURLToPath(new URL("../../fixtures/review-whiteboard", import.meta.url));
const PIN = "2ddf3eb6c13d97b1d04a932c21de9a92029adaf9";

let fx: Fixture;
afterEach(() => fx.cleanup());

async function whiteboardFacts(dir: string): Promise<string> {
  const result = await gatherReview({ reviewDir: FIXTURE, clonePath: "/clone/whiteboard", readHead: async () => PIN });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const file = path.join(dir, "facts.jsonl");
  writeFileSync(file, `${result.facts.map((fact) => JSON.stringify(fact)).join("\n")}\n`);
  return file;
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
