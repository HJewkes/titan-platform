import { readdir, readFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, beforeAll } from "vitest"
import {
  parseFile,
  NamingExtractor,
  StructureExtractor,
  DocumentationExtractor,
  ErrorHandlingExtractor,
} from "../index.js"
import type { Observation, ParsedFile } from "../extractors/types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORPUS_DIR = join(__dirname, "../../fixtures/corpus/typescript")

async function parseAllCorpusFiles(): Promise<ParsedFile[]> {
  const entries = await readdir(CORPUS_DIR)
  const tsFiles = entries.filter((f) => f.endsWith(".ts")).sort()
  const parsed: ParsedFile[] = []
  for (const fileName of tsFiles) {
    const filePath = join(CORPUS_DIR, fileName)
    const content = await readFile(filePath, "utf-8")
    const result = await parseFile(content, filePath, "typescript")
    parsed.push(result)
  }
  return parsed
}

function extractWith<T extends { extract(file: ParsedFile): Observation[] }>(
  extractor: T,
  parsedFiles: ParsedFile[],
): Observation[] {
  const observations: Observation[] = []
  for (const parsed of parsedFiles) {
    observations.push(...extractor.extract(parsed))
  }
  return observations
}

function majorityValue(observations: Observation[]): string {
  const counts = new Map<string, number>()
  for (const obs of observations) {
    const key = String(obs.value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let maxKey = ""
  let maxCount = 0
  for (const [key, count] of counts) {
    if (count > maxCount) {
      maxKey = key
      maxCount = count
    }
  }
  return maxKey
}

describe("NamingExtractor corpus behavior", () => {
  let observations: Observation[]

  beforeAll(async () => {
    const parsedFiles = await parseAllCorpusFiles()
    observations = extractWith(new NamingExtractor(), parsedFiles)
  })

  it("produces naming observations", () => {
    expect(observations.length).toBeGreaterThan(0)
    expect(observations.every((o) => o.category === "naming")).toBe(true)
  })

  it("majority of variable observations are camelCase", () => {
    const variableObs = observations.filter(
      (o) => o.type === "naming.variable",
    )
    expect(variableObs.length).toBeGreaterThan(0)
    const majority = majorityValue(variableObs)
    expect(majority).toBe("camelCase")
  })

  it("majority of function observations are camelCase", () => {
    const functionObs = observations.filter(
      (o) => o.type === "naming.function",
    )
    expect(functionObs.length).toBeGreaterThan(0)
    const majority = majorityValue(functionObs)
    expect(majority).toBe("camelCase")
  })

  it("type/class/interface observations are PascalCase", () => {
    const typeObs = observations.filter(
      (o) =>
        o.type === "naming.type" ||
        o.type === "naming.class" ||
        o.type === "naming.interface",
    )
    if (typeObs.length === 0) return
    const majority = majorityValue(typeObs)
    expect(majority).toBe("PascalCase")
  })
})

describe("StructureExtractor corpus behavior", () => {
  let observations: Observation[]

  beforeAll(async () => {
    const parsedFiles = await parseAllCorpusFiles()
    observations = extractWith(new StructureExtractor(), parsedFiles)
  })

  it("produces structure observations", () => {
    expect(observations.length).toBeGreaterThan(0)
    expect(observations.every((o) => o.category === "structure")).toBe(true)
  })

  it("detects import ordering patterns", () => {
    const importObs = observations.filter(
      (o) =>
        o.type.includes("import") ||
        o.type.includes("Import"),
    )
    expect(importObs.length).toBeGreaterThan(0)
  })
})

describe("DocumentationExtractor corpus behavior", () => {
  let observations: Observation[]

  beforeAll(async () => {
    const parsedFiles = await parseAllCorpusFiles()
    observations = extractWith(new DocumentationExtractor(), parsedFiles)
  })

  it("produces documentation observations", () => {
    expect(observations.length).toBeGreaterThan(0)
    expect(observations.every((o) => o.category === "documentation")).toBe(true)
  })

  it("detects jsdoc usage", () => {
    const jsdocObs = observations.filter(
      (o) =>
        o.type.includes("jsdoc") ||
        o.type.includes("Jsdoc") ||
        o.type.includes("doc") ||
        String(o.value).includes("jsdoc"),
    )
    expect(jsdocObs.length).toBeGreaterThan(0)
  })
})

describe("ErrorHandlingExtractor corpus behavior", () => {
  let observations: Observation[]

  beforeAll(async () => {
    const parsedFiles = await parseAllCorpusFiles()
    observations = extractWith(new ErrorHandlingExtractor(), parsedFiles)
  })

  it("produces error-handling observations when try-catch is present", () => {
    if (observations.length === 0) {
      return
    }
    expect(
      observations.every((o) => o.category === "error-handling"),
    ).toBe(true)
  })
})
