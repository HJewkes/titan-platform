import { describe, it, expect, beforeAll } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import { createStyleExtractors } from "../extractors/factory.js";
import { FormattingExtractor } from "../extractors/formatting.js";
import { IdiomsExtractor } from "../extractors/idioms.js";
import { STABILITY_MAP, UNRATED_TYPES, lookupStability } from "./stability.js";
import type { Observation } from "../extractors/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTORS_DIR = path.join(__dirname, "../extractors");
const FIXTURES_DIR = path.join(__dirname, "../../fixtures");

// Dotted string literals in extractor sources that are not observation types.
const NOT_OBSERVATION_TYPES = new Set(["prettier.config"]);

function scanEmittedTypes(): Set<string> {
  const literal = /"([A-Za-z][A-Za-z-]*\.[A-Za-z][A-Za-z-]*)"/g;
  const types = new Set<string>();
  const sources = fs
    .readdirSync(EXTRACTORS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "types.ts");
  for (const source of sources) {
    const text = fs.readFileSync(path.join(EXTRACTORS_DIR, source), "utf-8");
    for (const match of text.matchAll(literal)) {
      if (!NOT_OBSERVATION_TYPES.has(match[1]!)) types.add(match[1]!);
    }
  }
  return types;
}

async function observeFixtures(): Promise<Observation[]> {
  const extractors = createStyleExtractors();
  const names = fs.readdirSync(FIXTURES_DIR).filter((f) => /\.(ts|py)$/.test(f));
  const observations: Observation[] = [];
  const sources: { content: string; path: string; language: string }[] = [];
  for (const name of names) {
    const filePath = path.join(FIXTURES_DIR, name);
    const language = name.endsWith(".py") ? "python" : "typescript";
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = await parseFile(content, filePath, language);
    observations.push(...extractors.flatMap((e) => e.extract(parsed)));
    sources.push({ content, path: filePath, language });
  }
  observations.push(...(await new IdiomsExtractor().extractFromSources(sources)));
  const editorConfig = path.join(FIXTURES_DIR, "formatting-configs/.editorconfig");
  observations.push(...(await new FormattingExtractor().extractFromConfig(editorConfig)));
  return observations;
}

describe("STABILITY_MAP covers exactly the emitted observation types", () => {
  const emitted = scanEmittedTypes();

  it("finds the types of all nine extractors in their sources", () => {
    const categories = new Set([...emitted].map((t) => t.split(".")[0]));
    expect(categories.size).toBe(9);
  });

  it("rates every emitted type or lists it as unrated on purpose", () => {
    const missing = [...emitted].filter(
      (t) => STABILITY_MAP[t] === undefined && !UNRATED_TYPES.has(t),
    );
    expect(missing, `emitted types with no stability entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("keys only types an extractor emits, so a misspelled key cannot hide", () => {
    const dead = Object.keys(STABILITY_MAP).filter((k) => !emitted.has(k));
    expect(dead, `stability keys no extractor emits: ${dead.join(", ")}`).toEqual([]);
  });

  it("lists as unrated only emitted types that have no entry", () => {
    for (const type of UNRATED_TYPES) {
      expect(emitted.has(type), type).toBe(true);
      expect(STABILITY_MAP[type], type).toBeUndefined();
      expect(lookupStability(type)).toBe("medium");
    }
  });

  it("resolves a rated stability for the common naming and control-flow types", () => {
    expect(lookupStability("naming.variable")).toBe("high");
    expect(lookupStability("control-flow.guard-clause")).toBe("high");
    expect(lookupStability("documentation.jsdoc-presence")).toBe("high");
    expect(lookupStability("error-handling.try-catch")).toBe("high");
  });
});

describe("the source scan agrees with what the extractors emit at runtime", () => {
  let observed: Set<string>;

  beforeAll(async () => {
    observed = new Set((await observeFixtures()).map((o) => o.type));
  });

  it("sees every type the extractors emit over the fixtures", () => {
    const unscanned = [...observed].filter((t) => !scanEmittedTypes().has(t));
    expect(observed.size).toBeGreaterThan(40);
    expect(unscanned, `types built at runtime: ${unscanned.join(", ")}`).toEqual([]);
  });
});
