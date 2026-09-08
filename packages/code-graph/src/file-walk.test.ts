import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { walkSourceFiles } from "./file-walk.js";

describe("walkSourceFiles", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-walk-"));
    await fs.mkdir(path.join(root, "src/nested"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "src/a.ts"), "export const a = 1;");
    await fs.writeFile(path.join(root, "src/nested/b.ts"), "export const b = 2;");
    await fs.writeFile(path.join(root, "src/c.tsx"), "export const c = 3;");
    await fs.writeFile(path.join(root, "src/types.d.ts"), "export type T = number;");
    await fs.writeFile(path.join(root, "src/readme.md"), "# hi");
    await fs.writeFile(path.join(root, "src/script.py"), "def d():\n    return 4\n");
    await fs.writeFile(path.join(root, "node_modules/pkg/dep.ts"), "export const d = 4;");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const rel = (abs: string): string => path.relative(root, abs).split(path.sep).join("/");

  it("collects TypeScript files recursively", async () => {
    const found = (await walkSourceFiles([root], ["typescript"])).map(rel).sort();
    expect(found).toEqual(["src/a.ts", "src/c.tsx", "src/nested/b.ts"]);
  });

  it("excludes node_modules, .d.ts, and non-TS files", async () => {
    const found = (await walkSourceFiles([root], ["typescript"])).map(rel);
    expect(found).not.toContain("node_modules/pkg/dep.ts");
    expect(found).not.toContain("src/types.d.ts");
    expect(found).not.toContain("src/readme.md");
  });

  it("collects Python alongside TypeScript when both are requested", async () => {
    const found = (await walkSourceFiles([root], ["typescript", "python"])).map(rel).sort();
    expect(found).toContain("src/script.py");
  });

  it("dedupes a file reachable from two overlapping roots", async () => {
    const found = await walkSourceFiles([root, path.join(root, "src")], ["typescript"]);
    const aHits = found.filter((f) => f.endsWith("/a.ts")).length;
    expect(aHits).toBe(1);
  });
});
