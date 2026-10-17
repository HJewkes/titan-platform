import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "packages/tool-guard/dist/merge-lint-bin.js");

// Needs `pnpm build`, like every test that imports a sibling package's dist.
describe.skipIf(!existsSync(bin))("merge-lint on this repo's own tree", () => {
  const result = spawnSync(process.execPath, [bin], { cwd: root, encoding: "utf-8" });
  const lines = result.stdout.split("\n").filter(Boolean);

  it("reports no merge call outside the allowlist", () => {
    expect(lines.filter((l) => /^merge-lint: warn \S+:\d+:/.test(l))).toEqual([]);
  });

  it("reports no stale allow entry, so a renamed wrapper fails here instead of passing", () => {
    expect(lines.filter((l) => l.includes("stale allow entry"))).toEqual([]);
  });

  it("exits 0 at warn level and counts nothing unallowed", () => {
    expect(result.status).toBe(0);
    expect(lines.at(-1)).toMatch(/: 0 unallowed, \d+ allowed, 0 stale,/);
  });
});
