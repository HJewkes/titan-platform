import { describe, it, expect, vi, beforeAll } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createStyleExtractors } from "../extractors/factory.js";
import { ReviewVoiceExtractor } from "../extractors/review-voice.js";
import { Aggregator } from "../aggregator/aggregator.js";
import type { Observation } from "../extractors/types.js";
import { Enricher } from "./enricher.js";
import { AI_ENRICHED_FEATURES } from "./prompts.js";
import type { LlmProvider } from "./llm.js";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures",
);

const REVIEW_COMMENTS = [
  { body: "Please rename this, the naming is confusing." },
  { body: "What happens if this fails? Missing error handling." },
  { body: "This is too complex, split it up. Also DRY." },
];

async function observeFixtures(): Promise<Observation[]> {
  const extractors = createStyleExtractors();
  const observations: Observation[] = [];
  for (const name of fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".ts"))) {
    const filePath = path.join(FIXTURES_DIR, name);
    const parsed = await parseFile(fs.readFileSync(filePath, "utf-8"), filePath, "typescript");
    observations.push(...extractors.flatMap((e) => e.extract(parsed)));
  }
  observations.push(...new ReviewVoiceExtractor().extractFromComments(REVIEW_COMMENTS));
  return observations;
}

describe("AI_ENRICHED_FEATURES against real extractor output", () => {
  let observations: Observation[];

  beforeAll(async () => {
    observations = await observeFixtures();
  });

  it("names only types some extractor emits", () => {
    const emitted = new Set(observations.map((o) => o.type));
    const dead = AI_ENRICHED_FEATURES.filter((t) => !emitted.has(t));
    expect(dead, `enriched types no extractor emits: ${dead.join(", ")}`).toEqual([]);
  });

  it("builds at least one enrichment job from aggregated extractor output", async () => {
    const provider: LlmProvider = {
      name: "fake",
      generate: vi.fn().mockResolvedValue({ content: "A description.", tokensUsed: 10 }),
    };
    const { features } = new Aggregator().aggregate(observations);

    const result = await new Enricher({ provider }).enrich(features);

    expect(provider.generate).toHaveBeenCalled();
    expect(result.enriched.size).toBeGreaterThan(0);
    expect([...result.enriched.keys()].every((t) => AI_ENRICHED_FEATURES.includes(t))).toBe(true);
  });
});
