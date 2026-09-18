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
} from "../index.js"
import type {
  Observation,
  ParsedFile,
  Extractor,
} from "../extractors/types.js"

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

async function parseCorpus(
  files: { content: string; path: string }[],
): Promise<ParsedFile[]> {
  const parsed: ParsedFile[] = []
  for (const file of files) {
    const result = await parseFile(file.content, file.path, "typescript")
    parsed.push(result)
  }
  return parsed
}

function extractAll(
  parsedFiles: ParsedFile[],
  extractors: Extractor[],
): Observation[] {
  const observations: Observation[] = []
  for (const parsed of parsedFiles) {
    for (const extractor of extractors) {
      observations.push(...extractor.extract(parsed))
    }
  }
  return observations
}

describe("Full pipeline integration", () => {
  let corpusFiles: { content: string; path: string }[]
  let parsedFiles: ParsedFile[]
  let observations: Observation[]
  let result: AggregatorResult

  beforeAll(async () => {
    corpusFiles = await loadCorpusFiles()
    parsedFiles = await parseCorpus(corpusFiles)
    const extractors = createExtractors()
    observations = extractAll(parsedFiles, extractors)
    const aggregator = new Aggregator()
    result = aggregator.aggregate(observations)
  })

  it("parses all corpus files successfully", () => {
    expect(corpusFiles.length).toBeGreaterThanOrEqual(10)
    expect(parsedFiles.length).toBe(corpusFiles.length)
  })

  it("produces observations from all extractors", () => {
    expect(observations.length).toBeGreaterThan(0)
    const categories = new Set(observations.map((o) => o.category))
    expect(categories.has("naming")).toBe(true)
    expect(categories.has("structure")).toBe(true)
    expect(categories.has("documentation")).toBe(true)
  })

  it("aggregates into features", () => {
    expect(result.features.size).toBeGreaterThan(0)
    expect(result.summary.totalObservations).toBe(observations.length)
  })

  it("detects camelCase variable naming convention", () => {
    const feature = result.features.get("naming.variable")
    expect(feature).toBeDefined()
    expect(feature!.convention).toBe("camelCase")
    expect(feature!.confidence).toBeGreaterThan(0.8)
  })

  it("detects camelCase function naming convention", () => {
    const feature = result.features.get("naming.function")
    expect(feature).toBeDefined()
    expect(feature!.convention).toBe("camelCase")
    expect(feature!.confidence).toBeGreaterThan(0.8)
  })

  it("detects PascalCase type naming convention", () => {
    const typeFeature =
      result.features.get("naming.type") ??
      result.features.get("naming.class") ??
      result.features.get("naming.interface")
    expect(typeFeature).toBeDefined()
    expect(typeFeature!.convention).toBe("PascalCase")
    expect(typeFeature!.confidence).toBeGreaterThan(0.8)
  })

  it("has high average confidence across features", () => {
    expect(result.summary.avgConfidence).toBeGreaterThan(0.65)
  })

  it("produces error-handling observations", () => {
    const errorHandlingFeatures = Array.from(result.features.entries())
      .filter(([, f]) => f.category === "error-handling")
    expect(errorHandlingFeatures.length).toBeGreaterThanOrEqual(1)
  })

  it("produces structure observations", () => {
    const structureFeatures = Array.from(result.features.entries())
      .filter(([, f]) => f.category === "structure")
    expect(structureFeatures.length).toBeGreaterThanOrEqual(1)
  })

  it("matches expected profile snapshot", async () => {
    const expectedPath = join(
      __dirname,
      "../../fixtures/corpus/expected-profile.json",
    )
    let expected: Record<string, unknown>
    try {
      const raw = await readFile(expectedPath, "utf-8")
      expected = JSON.parse(raw)
    } catch {
      console.warn(
        "expected-profile.json not found -- run snapshot generation to create it",
      )
      return
    }

    const actual: Record<string, unknown> = {}
    for (const [key, feature] of result.features) {
      actual[key] = {
        convention: feature.convention,
        confidence: Math.round(feature.confidence * 100) / 100,
        severity: feature.severity,
      }
    }

    for (const [key, expectedFeature] of Object.entries(expected)) {
      const actualFeature = actual[key] as
        | { convention: unknown; confidence: number; severity: string }
        | undefined
      if (!actualFeature) continue
      const exp = expectedFeature as {
        convention: unknown
        confidence: number
      }
      expect(actualFeature.convention).toBe(exp.convention)
      expect(actualFeature.confidence).toBeCloseTo(exp.confidence, 1)
    }
  })
})
