import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HISTORY_DIR = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(HISTORY_DIR).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));

describe("history sources", () => {
  it("finds the history sources", () => expect(sources).toContain("build.ts"));

  // Kills: anyone adding `gh api graphql` or any gh spawn; history reads the graph, mirrors and gh-cache only.
  it.each(sources)("%s never names GraphQL or spawns gh", (file) => {
    const text = readFileSync(join(HISTORY_DIR, file), "utf8");

    expect(text).not.toMatch(/graphql/i);
    expect(text).not.toMatch(/["'`]gh["'`]/);
  });
});
