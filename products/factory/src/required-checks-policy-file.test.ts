import { readdirSync, readFileSync } from "node:fs";
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

/** Job ids of each workflow whose `on:` block names no `push`, so no run of them ever lands on a main sha. */
function pullRequestOnlyJobs(): string[] {
  const dir = new URL("../../../.github/workflows/", import.meta.url);
  return readdirSync(dir)
    .map((file) => readFileSync(new URL(file, dir), "utf8"))
    .filter((yaml) => !/\non:\n(?: {2}[^\n]*\n)*? {2}push:/.test(yaml))
    .flatMap((yaml) => [...(yaml.split(/\njobs:\n/)[1] ?? "").matchAll(/^ {2}([\w-]+):$/gm)].map((match) => match[1]!));
}

it("lists every required context a pull_request-only workflow runs as PR-only, so main's own CI can read green (TP-5485)", () => {
  const main = JSON.parse(readFileSync(new URL(`../../../${PATH}`, import.meta.url), "utf8")).branches.main;
  const prJobs = new Set(pullRequestOnlyJobs());

  expect(prJobs.has("fix-proof-mutants")).toBe(true);
  expect(main.contexts.filter((name: string) => prJobs.has(name))).toEqual(main.prContexts ?? []);
});
