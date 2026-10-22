import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** M1a ships the pool's emitters only (TP-3096 I15): no recipe or service waits on ApiAvailable or reads the pool-state table. */
const READS = /\bApiAvailable\b|\bfactory_github_api_pool\b|\bAPI_AVAILABLE\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Pure: whether a src-relative path is the pool's own module or a test, the only places either name may appear. */
function mayRead(path: string): boolean {
  return path.startsWith("github-api/") || path.endsWith(".test.ts");
}

describe("github-api pool consumers", () => {
  it("lets only github-api/ and tests mention ApiAvailable or the pool-state table", () => {
    const readers = sourceFiles(SRC)
      .map((path) => relative(SRC, path).split(sep).join("/"))
      .filter((path) => !mayRead(path))
      .filter((path) => READS.test(readFileSync(join(SRC, path), "utf8")));

    expect(readers).toEqual([]);
  });

  it("scans a tree that holds both names", () => {
    const paths = sourceFiles(SRC).map((path) => relative(SRC, path).split(sep).join("/"));
    const sources = paths.filter((path) => path.startsWith("github-api/") && !path.endsWith(".test.ts")).map((path) => readFileSync(join(SRC, path), "utf8"));

    expect(sources.some((source) => /\bApiAvailable\b/.test(source))).toBe(true);
    expect(sources.some((source) => /\bfactory_github_api_pool\b/.test(source))).toBe(true);
  });

  it("counts a recipe or service file as a reader and exempts the pool module and tests", () => {
    expect(["serve.ts", "workflows/x.ts", "shepherd/x.ts", "github-apis.ts"].filter(mayRead)).toEqual([]);
    expect(["github-api/emit.ts", "serve.test.ts"].every(mayRead)).toBe(true);
  });

  it("matches the event kind and the table name, not the health option", () => {
    expect(["kind: \"ApiAvailable\"", "FROM factory_github_api_pool", "API_AVAILABLE"].every((line) => READS.test(line))).toBe(true);
    expect(READS.test("githubApi?: () => GithubApiHealth")).toBe(false);
  });
});
