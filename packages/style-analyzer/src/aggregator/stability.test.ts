import { describe, it, expect, beforeAll } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import { NamingExtractor } from "../extractors/naming.js";
import { StructureExtractor } from "../extractors/structure.js";
import { ControlFlowExtractor } from "../extractors/control-flow.js";
import { DocumentationExtractor } from "../extractors/documentation.js";
import { ErrorHandlingExtractor } from "../extractors/error-handling.js";
import { STABILITY_MAP } from "./stability.js";
import type { Observation } from "../extractors/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("STABILITY_MAP drift prevention", () => {
  let observations: Observation[];

  beforeAll(async () => {
    const fixturePath = path.join(__dirname, "../../fixtures", "structure-sample.ts");
    const content = fs.readFileSync(fixturePath, "utf-8");
    const parsed = await parseFile(content, fixturePath, "typescript");

    const extractors = [
      new NamingExtractor(),
      new StructureExtractor(),
      new ControlFlowExtractor(),
      new DocumentationExtractor(),
      new ErrorHandlingExtractor(),
    ];

    observations = extractors.flatMap((e) => e.extract(parsed));
  });

  // Known mismatches: extractors emit kebab-case or singular forms but
  // STABILITY_MAP uses camelCase or plural forms. These fall through to
  // category-level lookup in lookupStability(). Fix tracked separately.
  const KNOWN_KEY_DRIFT = new Set([
    // Naming: extractor emits singular, map has plural
    "naming.variable",
    "naming.function",
    "naming.type",
    "naming.constant",
    "naming.boolean",
    "naming.parameter",
    "naming.enum",
    // Documentation: extractor emits kebab-case, map has camelCase
    "documentation.jsdoc-presence",
    "documentation.public-coverage",
    "documentation.private-coverage",
    "documentation.inline-comment",
    "documentation.comment-placement",
    "documentation.jsdoc-tag",
  ]);

  it("has a STABILITY_MAP entry for every observation type emitted by extractors", () => {
    const types = [...new Set(observations.map((o) => o.type))];
    expect(types.length).toBeGreaterThan(0);

    const uncovered: string[] = [];
    for (const type of types) {
      if (KNOWN_KEY_DRIFT.has(type)) continue;
      if (STABILITY_MAP[type] === undefined) {
        uncovered.push(type);
      }
    }
    expect(
      uncovered,
      `Missing STABILITY_MAP entries: ${uncovered.join(", ")}`,
    ).toHaveLength(0);
  });

  it("tracks known naming drift that needs fixing", () => {
    const emittedTypes = new Set(observations.map((o) => o.type));
    const driftTypes = [...KNOWN_KEY_DRIFT].filter((t) => emittedTypes.has(t));
    expect(driftTypes.length).toBeGreaterThan(0);

    // When the naming keys are fixed, remove KNOWN_KEY_DRIFT and
    // this test will fail, reminding you to clean up the allowlist.
    for (const type of driftTypes) {
      expect(
        STABILITY_MAP[type],
        `"${type}" now has a STABILITY_MAP entry -- remove it from KNOWN_KEY_DRIFT`,
      ).toBeUndefined();
    }
  });
});
