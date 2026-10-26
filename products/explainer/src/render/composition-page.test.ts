import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachedPage, treeSha, type PageBuild, type PageSource } from "./composition-page.js";

let dir: string;
let source: PageSource;
let cache: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "explainer-page-cache-"));
  const root = path.join(dir, "composition");
  mkdirSync(path.join(root, "beats"), { recursive: true });
  writeFileSync(path.join(root, "main.tsx"), "export const main = 1;\n");
  writeFileSync(path.join(root, "beats", "hook.tsx"), "export const hook = 1;\n");
  writeFileSync(path.join(root, "page.test.ts"), "// a test\n");
  writeFileSync(path.join(dir, "beat-slots.ts"), "export const slots = 1;\n");
  source = { root, extra: [path.join(dir, "beat-slots.ts")] };
  cache = path.join(dir, "cache");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for the Vite build that counts its runs and writes one file. */
function countingBuild(): { build: PageBuild; runs: () => number } {
  let runs = 0;
  const build: PageBuild = async (outDir) => {
    runs++;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "index.html"), `<!doctype html><!-- build ${runs} -->`);
  };
  return { build, runs: () => runs };
}

describe("cachedPage", () => {
  it("builds the page once per source sha and reuses the cached tree", async () => {
    const { build, runs } = countingBuild();

    const first = await cachedPage(source, cache, build);
    const second = await cachedPage(source, cache, build);

    expect(runs()).toBe(1);
    expect(second).toEqual(first);
    expect(first.sha).toBe(treeSha(first.dir));
  });

  it("rebuilds after a page source or an extra file changes, but not after a test file changes", async () => {
    const { build, runs } = countingBuild();
    await cachedPage(source, cache, build);

    writeFileSync(path.join(source.root, "page.test.ts"), "// an edited test\n");
    await cachedPage(source, cache, build);
    writeFileSync(path.join(source.root, "beats", "hook.tsx"), "export const hook = 2;\n");
    await cachedPage(source, cache, build);
    writeFileSync(path.join(dir, "beat-slots.ts"), "export const slots = 2;\n");
    await cachedPage(source, cache, build);

    expect(runs()).toBe(3);
    expect(readdirSync(cache)).toHaveLength(3);
  });

  it("a build that fails leaves no cache entry, so the next call builds again", async () => {
    const failing: PageBuild = async (outDir) => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, "index.html"), "half");
      throw new Error("vite failed");
    };
    const { build, runs } = countingBuild();

    await expect(cachedPage(source, cache, failing)).rejects.toThrow("vite failed");
    const page = await cachedPage(source, cache, build);

    expect(runs()).toBe(1);
    expect(readdirSync(cache)).toEqual([path.basename(page.dir)]);
    expect(existsSync(path.join(page.dir, "index.html"))).toBe(true);
  });
});

describe("treeSha", () => {
  it("is equal for equal trees in different places and changes with a file's bytes", () => {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    for (const tree of [a, b]) {
      mkdirSync(path.join(tree, "assets"), { recursive: true });
      writeFileSync(path.join(tree, "index.html"), "page");
      writeFileSync(path.join(tree, "assets", "main.js"), "code");
    }
    const equal = treeSha(a) === treeSha(b);

    writeFileSync(path.join(b, "assets", "main.js"), "other code");

    expect(equal).toBe(true);
    expect(treeSha(b)).not.toBe(treeSha(a));
  });
});
