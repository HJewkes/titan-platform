import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFile } from "@titan-design/code-parser";
import { TsMorphGraphExtractor } from "./ts-morph-extractor.js";

const AMBIENT_TYPES = "interface FakeTag { tag: string }\ndeclare const FAKE_GLOBAL: FakeTag;\n";
const USES_AMBIENT = "export function tag() {\n  return FAKE_GLOBAL;\n}\n";

async function tagSignature(repoRoot: string): Promise<unknown> {
  const filePath = path.join(repoRoot, "src", "a.ts");
  const parsed = await parseFile(USES_AMBIENT, filePath, "typescript");
  const [fragment] = new TsMorphGraphExtractor({ repoRoot }).extract(parsed);
  return fragment!.nodes.find((n) => n.id === "src/a.ts#tag")?.attrs?.signature;
}

describe("automatic @types for an extractor without a tsconfig", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-type-roots-")));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeAmbientTypes(dir: string): Promise<void> {
    const typesDir = path.join(dir, "node_modules", "@types", "fake");
    await fs.mkdir(typesDir, { recursive: true });
    await fs.writeFile(path.join(typesDir, "index.d.ts"), AMBIENT_TYPES);
  }

  it("infers types from the indexed repo's own node_modules/@types", async () => {
    const repoRoot = path.join(tmp, "repo");
    await writeAmbientTypes(repoRoot);

    expect(await tagSignature(repoRoot)).toBe("tag(): FakeTag");
  });

  it("does not load @types from the process working directory", async () => {
    const repoRoot = path.join(tmp, "repo");
    const elsewhere = path.join(tmp, "elsewhere");
    await writeAmbientTypes(elsewhere);
    const cwd = process.cwd();
    process.chdir(elsewhere);
    try {
      expect(await tagSignature(repoRoot)).not.toContain("FakeTag");
    } finally {
      process.chdir(cwd);
    }
  });
});
