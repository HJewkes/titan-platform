import { describe, expect, it } from "vitest";
import { parseFile } from "./parser/index.js";
import { classifyForReuse, hashContent, structuralSignature, type ReuseBasis } from "./incremental.js";

const SRC = `export function add(a: number, b: number): number {
  return a + b;
}
`;

const sign = async (source: string): Promise<string> =>
  structuralSignature(await parseFile(source, "/repo/src/a.ts", "typescript"));

/** A basis carrying just the fingerprints the reuse classifier reads. */
function basis(fingerprints: Record<string, string>): ReuseBasis {
  return {
    snapshotId: 1,
    fingerprints: new Map(Object.entries(fingerprints)),
    structuralHashes: new Map(),
    nodesById: new Map(),
    edgesBySrc: new Map(),
    sourceMetricsByFile: new Map(),
    symbolsByFile: new Map(),
  };
}

describe("structuralSignature", () => {
  it("is unchanged by a comment or whitespace edit", async () => {
    const before = await sign(SRC);
    expect(await sign(`// explain the thing\n${SRC}`)).toBe(before);
    expect(await sign(SRC.replace("return a + b;", "  return a   +   b;"))).toBe(before);
  });

  it("changes when a token changes", async () => {
    expect(await sign(SRC.replace("a + b", "a - b"))).not.toBe(await sign(SRC));
    expect(await sign(SRC.replace("add", "sum"))).not.toBe(await sign(SRC));
  });
});

describe("classifyForReuse", () => {
  const readFile = (filePath: string, content: string) =>
    ({ filePath, language: "typescript", content, hash: hashContent(content) }) as const;

  it("reuses a file whose content hash matches the basis", () => {
    const rf = readFile("/repo/src/a.ts", SRC);
    const { toParse, reusedFileIds } = classifyForReuse([rf], "/repo", basis({ "src/a.ts": rf.hash }));
    expect(reusedFileIds).toEqual(["src/a.ts"]);
    expect(toParse).toEqual([]);
  });

  it("re-parses a changed file and a file with no basis entry", () => {
    const changed = readFile("/repo/src/a.ts", `${SRC}export const x = 1;\n`);
    const fresh = readFile("/repo/src/b.ts", SRC);
    const { toParse } = classifyForReuse([changed, fresh], "/repo", basis({ "src/a.ts": "stale" }));
    expect(toParse.map((f) => f.filePath)).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
  });

  it("re-parses an unchanged file the membership delta marked affected", () => {
    const rf = readFile("/repo/src/a.ts", SRC);
    const { toParse, reusedFileIds } = classifyForReuse(
      [rf],
      "/repo",
      basis({ "src/a.ts": rf.hash }),
      new Set(["src/a.ts"]),
    );
    expect(reusedFileIds).toEqual([]);
    expect(toParse).toHaveLength(1);
  });
});
