import { readdir, readFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, beforeAll } from "vitest"
import {
  parseFile,
  NamingExtractor,
  StructureExtractor,
  ControlFlowExtractor,
  DocumentationExtractor,
  ErrorHandlingExtractor,
  Aggregator,
  type AggregatorResult,
  type AggregatedFeature,
} from "@titan-design/style-analyzer"
import type { Observation, Extractor } from "@titan-design/style-analyzer"
import {
  ProfileSchema,
  SCHEMA_VERSION,
  DEFAULT_SEVERITY_THRESHOLDS,
  PROFILE_CATEGORIES,
} from "@titan-design/style-profile"
import type { Profile, ProfileCategory, StyleRule } from "@titan-design/style-profile"
import { diffAgainstProfile } from "./diff-against-profile.js"
import type { DiffResult } from "./diff-against-profile.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORPUS_DIR = join(__dirname, "../../fixtures/corpus/typescript")

function createExtractors(): Extractor[] {
  return [
    new NamingExtractor(),
    new StructureExtractor(),
    new ControlFlowExtractor(),
    new DocumentationExtractor(),
    new ErrorHandlingExtractor(),
  ]
}

async function loadCorpusFiles(): Promise<{ content: string; path: string }[]> {
  const entries = await readdir(CORPUS_DIR)
  const tsFiles = entries.filter((f) => f.endsWith(".ts")).sort()
  const files: { content: string; path: string }[] = []
  for (const fileName of tsFiles) {
    const filePath = join(CORPUS_DIR, fileName)
    const content = await readFile(filePath, "utf-8")
    files.push({ content, path: filePath })
  }
  return files
}

async function runFullPipeline(): Promise<{
  observations: Observation[]
  result: AggregatorResult
}> {
  const corpusFiles = await loadCorpusFiles()
  const extractors = createExtractors()
  const observations: Observation[] = []

  for (const file of corpusFiles) {
    const parsed = await parseFile(file.content, file.path, "typescript")
    for (const extractor of extractors) {
      observations.push(...extractor.extract(parsed))
    }
  }

  const aggregator = new Aggregator()
  const result = aggregator.aggregate(observations)
  return { observations, result }
}

/**
 * Convert AggregatorResult features into a Profile-compatible shape.
 * Groups features by their category prefix (e.g. "naming.variable" -> naming)
 * and builds StyleRule entries for each.
 */
function buildProfileFromFeatures(
  features: Map<string, AggregatedFeature>,
): Profile {
  const categoryMap: Record<string, Record<string, StyleRule>> = {}

  for (const category of PROFILE_CATEGORIES) {
    categoryMap[category] = {}
  }

  for (const [featureType, feature] of features) {
    const dotIndex = featureType.indexOf(".")
    if (dotIndex < 0) continue

    const category = featureType.substring(0, dotIndex)
    const ruleName = featureType.substring(dotIndex + 1)

    let profileCategory: string
    if (category === "error-handling") {
      profileCategory = "errorHandling"
    } else if (category === "control-flow") {
      profileCategory = "patterns"
    } else if (
      PROFILE_CATEGORIES.includes(category as ProfileCategory)
    ) {
      profileCategory = category
    } else {
      continue
    }

    if (!categoryMap[profileCategory]) {
      categoryMap[profileCategory] = {}
    }

    categoryMap[profileCategory]![ruleName] = {
      convention: feature.convention as string | number | boolean | string[],
      confidence: feature.confidence,
      stability: feature.stability,
    }
  }

  const profile: Profile = ProfileSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    author: "integration-test",
    generated: new Date().toISOString(),
    sources: ["golden-corpus"],
    naming: categoryMap["naming"] ?? {},
    structure: categoryMap["structure"] ?? {},
    documentation: categoryMap["documentation"] ?? {},
    errorHandling: categoryMap["errorHandling"] ?? {},
    formatting: categoryMap["formatting"] ?? {},
    patterns: categoryMap["patterns"] ?? {},
    idioms: { detected: [] },
    antiPatterns: { acknowledged: [] },
    overrides: [],
    severityThresholds: DEFAULT_SEVERITY_THRESHOLDS,
  })

  return profile
}

describe("Profile roundtrip integration", () => {
  let observations: Observation[]
  let aggregatorResult: AggregatorResult
  let profile: Profile
  let diffResult: DiffResult

  beforeAll(async () => {
    const pipeline = await runFullPipeline()
    observations = pipeline.observations
    aggregatorResult = pipeline.result

    profile = buildProfileFromFeatures(aggregatorResult.features)
    diffResult = diffAgainstProfile(profile, observations)
  })

  it("parses corpus and produces observations", () => {
    expect(observations.length).toBeGreaterThan(0)
  })

  it("aggregates into features", () => {
    expect(aggregatorResult.features.size).toBeGreaterThan(0)
  })

  it("produces a valid profile from aggregated features", () => {
    expect(profile.schemaVersion).toBe(SCHEMA_VERSION)
    expect(profile.naming).toBeDefined()
    expect(Object.keys(profile.naming).length).toBeGreaterThan(0)
  })

  it("profile contains expected naming conventions", () => {
    const variableRule = profile.naming["variable"]
    if (variableRule) {
      expect(variableRule.convention).toBe("camelCase")
    }

    const functionRule = profile.naming["function"]
    if (functionRule) {
      expect(functionRule.convention).toBe("camelCase")
    }
  })

  it("diffing the same corpus against its own profile yields low deviations", () => {
    const { total, deviating } = diffResult.summary
    expect(total).toBeGreaterThan(0)

    // Some observations (control-flow, error-handling, complexity, etc.) don't map
    // to profile categories, so they inflate the total without being matchable.
    const deviationRate = deviating / total
    expect(deviationRate).toBeLessThan(0.15)
  })

  it("majority of observations match the profile", () => {
    const { total, matching } = diffResult.summary
    expect(total).toBeGreaterThan(0)

    const matchRate = matching / total
    expect(matchRate).toBeGreaterThan(0.7)
  })

  it("deviations are low severity when present", () => {
    if (diffResult.deviations.length === 0) return

    const errorDeviations = diffResult.deviations.filter(
      (d) => d.severity === "error",
    )
    const errorRate = errorDeviations.length / diffResult.deviations.length
    expect(errorRate).toBeLessThan(0.5)
  })

  it("all profile categories have valid StyleRule entries", () => {
    for (const category of PROFILE_CATEGORIES) {
      const section = profile[category]
      if (!section) continue
      for (const [, rule] of Object.entries(section)) {
        expect(rule.convention).toBeDefined()
        expect(rule.confidence).toBeGreaterThanOrEqual(0)
        expect(rule.confidence).toBeLessThanOrEqual(1)
      }
    }
  })

  it("roundtrip preserves high-confidence conventions", () => {
    const highConfFeatures = Array.from(aggregatorResult.features.entries())
      .filter(([, f]) => f.confidence > 0.85)

    for (const [featureType] of highConfFeatures) {
      const featureDeviations = diffResult.deviations.filter(
        (d) => d.rule === featureType,
      )
      const featureObservations = observations.filter(
        (o) => o.type === featureType,
      )

      if (featureObservations.length === 0) continue

      const featureDeviationRate =
        featureDeviations.length / featureObservations.length
      expect(featureDeviationRate).toBeLessThan(0.2)
    }
  })
})
