import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { indexPaths, openCodeGraph } from "@titan-design/code-graph";
import { afterEach, describe, expect, it } from "vitest";
import { reviewScopeFiles, scopedSource } from "./review-scope.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function cloneWith(files: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rx-scope-clone-"));
  temps.push(dir);
  for (const file of files) {
    await mkdir(join(dir, dirname(file)), { recursive: true });
    await writeFile(join(dir, file), "export const value = 1;\n");
  }
  return dir;
}

describe("scopedSource", () => {
  it("lists only scoped files even when a scoped directory holds unscoped siblings", async () => {
    const clone = await cloneWith(["app/in.ts", "app/vendored.ts", "bundled/big.ts"]);
    const source = scopedSource(clone, ["app/in.ts"]);

    const listed = await source.listFiles([clone], ["typescript"]);

    expect(listed).toEqual([join(clone, "app/in.ts")]);
  });

  it("lists only scoped files of every language, not just scripts", async () => {
    const clone = await cloneWith(["app/in.py", "app/vendored.py"]);
    const source = scopedSource(clone, ["app/in.py"]);

    const listed = await source.listFiles([clone], ["python"]);

    expect(listed).toEqual([join(clone, "app/in.py")]);
  });

  it("hides unscoped scripts from the type checker's file system but not scoped files or other kinds", async () => {
    const clone = await cloneWith(["app/in.ts", "app/vendored.ts"]);
    await writeFile(join(clone, "app/notes.md"), "notes\n");
    const source = scopedSource(clone, ["app/in.ts"]);

    expect(source.fileSystem.fileExistsSync(join(clone, "app/in.ts"))).toBe(true);
    expect(source.fileSystem.fileExistsSync(join(clone, "app/vendored.ts"))).toBe(false);
    expect(source.fileExists(join(clone, "app/vendored.ts"))).toBe(false);
    expect(() => source.readFile(join(clone, "app/vendored.ts"))).toThrow();
    expect(source.fileExists(join(clone, "app/notes.md"))).toBe(true);
  });
});

describe("reviewScopeFiles", () => {
  it("returns the file nodes of the newest snapshot as repo-relative ids, and nothing for an empty index", async () => {
    const clone = await cloneWith(["app/in.ts", "app/other.ts", "bundled/big.ts"]);
    const dbDir = await mkdtemp(join(tmpdir(), "rx-scope-db-"));
    temps.push(dbDir);
    const store = openCodeGraph(join(dbDir, "graph.db"));
    expect(reviewScopeFiles(store)).toEqual([]);
    await indexPaths(store, { paths: [clone], commitHash: "1".repeat(40), computeMetrics: false, computeChurn: false });

    const scope = reviewScopeFiles(store);
    store.close();

    expect(scope).toEqual(["app/in.ts", "app/other.ts", "bundled/big.ts"]);
  });
});
