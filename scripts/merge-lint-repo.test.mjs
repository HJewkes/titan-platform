import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "packages/tool-guard/dist/merge-lint-bin.js");

// Needs `pnpm build`, like every test that imports a sibling package's dist.
describe.skipIf(!existsSync(bin))("merge-lint on this repo's own tree", () => {
  const result = spawnSync(process.execPath, [bin], { cwd: root, encoding: "utf-8", env: { ...process.env, GITHUB_ACTIONS: "" } });
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

// The I9 form: without its allow entry, the ratchet is the only merge path the lint finds outside the list.
describe.skipIf(!existsSync(bin))("merge-lint with the autoresearch-ratchet entry removed", () => {
  const scratch = mkdtempSync(join(tmpdir(), "merge-lint-rules-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const rules = JSON.parse(readFileSync(join(root, ".github/merge-lint.json"), "utf-8"));
  const rulesPath = join(scratch, "merge-lint.json");
  writeFileSync(rulesPath, JSON.stringify({ ...rules, allow: rules.allow.filter((entry) => entry.mergePath !== "autoresearch-ratchet") }));
  const result = spawnSync(process.execPath, [bin, "--rules", rulesPath], { cwd: root, encoding: "utf-8", env: { ...process.env, GITHUB_ACTIONS: "" } });
  const unallowed = result.stdout.split("\n").filter((l) => /^merge-lint: warn \S+:\d+:/.test(l));

  it("reports only the ratchet's push and seed lines as unallowed", () => {
    expect(unallowed).toHaveLength(2);
    for (const line of unallowed) expect(line).toMatch(/^merge-lint: warn products\/factory\/src\/autoresearch\/ratchet\.ts:\d+: git-refspec-push/);
  });
});
