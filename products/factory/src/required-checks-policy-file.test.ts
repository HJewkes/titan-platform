import { readFileSync } from "node:fs";
import { fakeGitHub, githubPort } from "@titan-design/github";
import { expect, it } from "vitest";
import { readChecksPolicy } from "./required-checks-policy.js";

const REPO = "HJewkes/titan-platform";
const PATH = ".github/required-checks.json";

it("reads titan-platform's own committed required-checks policy as readable for main", async () => {
  const content = readFileSync(
    new URL(`../../../${PATH}`, import.meta.url),
    "utf8"
  );
  const fake = fakeGitHub({ repo: REPO });
  fake.files.set(`main:${PATH}`, { content, blobSha: "blob-1" });

  const result = await readChecksPolicy(githubPort(fake.wire), REPO, "main");

  expect(result.readable).toBe(true);
  const contexts = result.readable ? result.contexts : [];
  expect(contexts.length).toBeGreaterThan(0);
  expect(new Set(contexts).size).toBe(contexts.length);
});

it("lists every main-only test shard in ci.yml as a main-only context, so a red shard freezes main (TP-4401)", () => {
  const policy = JSON.parse(readFileSync(new URL(`../../../${PATH}`, import.meta.url), "utf8"));
  const ci = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const matrix = /\n {2}test-shard:\n[\s\S]*?\n {8}shard: \[([^\]]+)\]/.exec(ci);
  const shards = (matrix?.[1] ?? "").split(",").map((shard) => `test-shard (${shard.trim()})`);

  expect(shards.length).toBeGreaterThan(0);
  expect(policy.branches.main.mainContexts).toEqual(shards);
});
