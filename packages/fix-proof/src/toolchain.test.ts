import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toolchainOf } from "./toolchain.js";

const trees: string[] = [];

function treeWith(...files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-toolchain-"));
  trees.push(dir);
  files.forEach((file) => fs.writeFileSync(path.join(dir, file), ""));
  return dir;
}

afterEach(() => trees.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("toolchainOf", () => {
  it("installs a pnpm tree from its frozen lockfile and builds and tests with pnpm", () => {
    expect(toolchainOf(treeWith("pnpm-lock.yaml"))).toEqual({
      install: "pnpm install --frozen-lockfile",
      build: "pnpm build",
      command: "pnpm exec vitest run",
    });
  });

  it("installs an npm-only tree with npm ci and never downloads a missing vitest", () => {
    expect(toolchainOf(treeWith("package-lock.json"))).toEqual({
      install: "npm ci --no-audit --no-fund",
      build: "npm run build --if-present",
      command: "npm exec --no -- vitest run",
    });
  });

  it("keeps pnpm when a tree carries both lockfiles", () => {
    expect(toolchainOf(treeWith("package-lock.json", "pnpm-lock.yaml")).install).toBe("pnpm install --frozen-lockfile");
  });

  it("skips the install for a tree with no lockfile and keeps the pnpm build and test defaults", () => {
    expect(toolchainOf(treeWith())).toEqual({ install: null, build: "pnpm build", command: "pnpm exec vitest run" });
  });
});
