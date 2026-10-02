import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { parseFile } from "@titan-design/code-parser";
import { TsMorphGraphExtractor } from "./ts-morph-extractor.js";

const FILE_COUNT = 150;
const SLOW_TEST_TIMEOUT_MS = 60_000;

async function extractMany(extractor: TsMorphGraphExtractor) {
  for (let i = 0; i < FILE_COUNT; i++) {
    const file = await parseFile(`export const v${i} = ${i};\n`, `/repo/src/f${i}.ts`, "typescript");
    extractor.extract(file);
  }
}

function loadedFiles(extractor: TsMorphGraphExtractor): number {
  return (extractor as unknown as { project: Project }).project.getSourceFiles().length;
}

describe("TsMorphGraphExtractor source file retention", () => {
  it("does not hold every extracted file when it owns its project", async () => {
    const extractor = new TsMorphGraphExtractor({ repoRoot: "/repo" });
    await extractMany(extractor);
    expect(loadedFiles(extractor)).toBeLessThan(FILE_COUNT / 2);
  }, SLOW_TEST_TIMEOUT_MS);

  it("leaves files in a project the caller supplied", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
    await extractMany(new TsMorphGraphExtractor({ repoRoot: "/repo", project }));
    expect(project.getSourceFiles()).toHaveLength(FILE_COUNT);
  }, SLOW_TEST_TIMEOUT_MS);
});
