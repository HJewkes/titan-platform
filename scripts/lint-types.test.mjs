import { globSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TYPED_FILES } from "../eslint.typed.config.js";
import { chunkExit, chunkGroups, runChunks, typedGroups } from "./lint-types.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const groupsOfSize = (...sizes) => sizes.map((files, i) => ({ pattern: `g${i}`, dir: `d${i}`, files }));

describe("lint:types chunking", () => {
  it("lints every typed file in the repo exactly once across all chunks", () => {
    const chunks = chunkGroups(typedGroups(REPO, TYPED_FILES), 600);

    const linted = chunks.flatMap((chunk) => globSync(chunk.map((group) => group.pattern), { cwd: REPO }));

    expect(new Set(linted).size).toBe(linted.length);
    expect(new Set(linted)).toEqual(new Set(globSync(TYPED_FILES, { cwd: REPO })));
  });

  it("puts a group larger than the cap in a chunk of its own and packs the rest greedily", () => {
    const chunks = chunkGroups(groupsOfSize(700, 100, 450, 200), 600);

    expect(chunks.map((chunk) => chunk.map((group) => group.files))).toEqual([[700], [100, 450], [200]]);
  });
});

describe("lint:types exit codes", () => {
  it.each([
    ["the abort signal", { status: null, signal: "SIGABRT" }],
    ["exit status 134", { status: 134, signal: null }],
  ])("names the chunk's dirs and exits 2 when a chunk dies on the heap cap with %s", (_, result) => {
    const { code, message } = chunkExit(result, ["products/factory/src"]);

    expect(code).toBe(2);
    expect(message).toContain("products/factory/src");
    expect(message).toContain("out of memory");
  });

  it("runs every chunk after a lint failure and exits with the worst status", () => {
    const statuses = [0, 1, 0];
    const ran = [];
    const run = (patterns) => {
      ran.push(patterns);
      return { status: statuses[ran.length - 1], signal: null };
    };

    const code = runChunks([groupsOfSize(1), groupsOfSize(2), groupsOfSize(3)], run, () => {});

    expect(code).toBe(1);
    expect(ran).toHaveLength(3);
  });
});
