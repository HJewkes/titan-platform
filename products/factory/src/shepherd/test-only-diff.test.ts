import { CONFIG_PATH } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, PR_FILES_CAP, type GitHubPort, type PrFile } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { testOnlyDiff } from "./test-only-diff.js";

const REPO = "o/r";
const REPO_CONFIG = JSON.stringify({
  tests: ["{packages,products,apps}/*/src/**/*.test.{ts,tsx}", "apps/*/{scripts,server}/**/*.test.ts", "scripts/**/*.test.mjs"],
  carry: ["**/fixtures/**", "**/__fixtures__/**", "**/test-support/**", "**/testdata/**", "**/*.test-helpers.ts", "**/*.fixture.ts"],
});

const modified = (path: string): PrFile => ({ path, status: "modified" });

const HEAD = fakeSha("head");
const MERGE_BASE = fakeSha("merge-base");
const LOOSE_CONFIG = JSON.stringify({ tests: ["**/*.test.ts"], carry: ["**/*.ts"] });

type SceneOptions = { baseConfig?: string | null; changedFiles?: number; baseRef?: string; branchConfig?: string };

function sceneFake(files: PrFile[], options: SceneOptions = {}) {
  const fake = fakeGitHub();
  const baseRef = options.baseRef ?? "main";
  fake.addPr({ headSha: HEAD, baseRef });
  fake.prFiles.set(1, files);
  if (options.changedFiles !== undefined) fake.prChangedFiles.set(1, options.changedFiles);
  fake.compares.set(`main...${HEAD}`, { mergeBaseSha: MERGE_BASE, files: [] });
  const baseConfig = options.baseConfig === undefined ? REPO_CONFIG : options.baseConfig;
  if (baseConfig !== null) fake.files.set(`${MERGE_BASE}:${CONFIG_PATH}`, { content: baseConfig, blobSha: "b".repeat(40) });
  if (options.branchConfig !== undefined) fake.files.set(`${baseRef}:${CONFIG_PATH}`, { content: options.branchConfig, blobSha: "c".repeat(40) });
  return fake;
}

const scene = (files: PrFile[], options: SceneOptions = {}) => githubPort(sceneFake(files, options).wire);
const testAndSource = [modified("packages/x/src/a.test.ts"), modified("packages/x/src/x.ts")];

describe("testOnlyDiff", () => {
  it("reads Z7's tests-and-changeset diff as test-only", async () => {
    const port = scene([modified(".changeset/tp-2677-restart-contract.md"), modified("products/factory/src/restart-contract.test.ts")]);

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "test-only" });
  });

  it("reads Z8's diff, with test-support files, as test-only", async () => {
    const port = scene([
      { path: ".changeset/z8-serve-restart-resume.md", status: "added" },
      { path: "products/factory/src/serve-restart-resume.test.ts", status: "added" },
      { path: "products/factory/src/test-support/serve-child-main.ts", status: "added" },
      { path: "products/factory/src/test-support/serve-child.ts", status: "added" },
    ]);

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "test-only" });
  });

  it("reads a test with its mutation spec as test-only", async () => {
    const port = scene([modified("packages/x/src/a.test.ts"), { path: "packages/x/src/a.mutations.json", status: "added" }]);

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "test-only" });
  });

  it("names the source path when a test PR also changes source", async () => {
    const port = scene([modified("packages/x/src/a.test.ts"), modified("packages/x/src/x.ts")]);

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "source", paths: ["packages/x/src/x.ts"] });
  });

  it("counts a source file renamed into a test as a source change", async () => {
    const port = scene([{ path: "packages/x/src/x.test.ts", previousPath: "packages/x/src/x.ts", status: "renamed" }]);

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "source", paths: ["packages/x/src/x.ts"] });
  });

  it("counts a harness path as source even when a carry glob matches it", async () => {
    const port = scene([modified("packages/x/src/a.test.ts"), modified(".github/actions/fixtures/setup.json"), modified(".github/workflows/fix-proof.yml")]);

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "source", paths: [".github/actions/fixtures/setup.json", ".github/workflows/fix-proof.yml"] });
  });

  it("classifies with the default branch's merge-base globs, not the defaults", async () => {
    const port = scene([modified("packages/x/src/a.test.ts")], { baseConfig: JSON.stringify({ tests: ["apps/**/*.test.ts"] }) });

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "source", paths: ["packages/x/src/a.test.ts"] });
  });

  it("never reads a stacked PR's parent branch config that loosens the globs", async () => {
    const port = scene(testAndSource, { baseRef: "parent", branchConfig: LOOSE_CONFIG });

    const diff = await testOnlyDiff(port, REPO, 1);

    expect(diff).toMatchObject({ kind: "unread", reason: expect.stringMatching(/"parent".*"main"/) });
  });

  it("reads the merge-base config, not the default branch's tip", async () => {
    const port = scene(testAndSource, { branchConfig: LOOSE_CONFIG });

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "source", paths: ["packages/x/src/x.ts"] });
  });

  it("uses the built-in globs when the merge base has no config", async () => {
    const port = scene([modified("packages/x/src/a.test.ts")], { baseConfig: null, branchConfig: LOOSE_CONFIG });

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "test-only" });
  });

  it("fails closed when the default branch cannot be read", async () => {
    const fake = sceneFake([modified("packages/x/src/a.test.ts")]);
    fake.readFaults.getDefaultBranch = [new Error("HTTP 502")];

    expect(await testOnlyDiff(githubPort(fake.wire), REPO, 1)).toMatchObject({ kind: "unread", reason: expect.stringContaining("could not be read at the default branch's merge base") });
  });

  it("fails closed when the compare fails", async () => {
    const port: GitHubPort = { ...scene([modified("packages/x/src/a.test.ts")]), compareFiles: () => Promise.reject(new Error("HTTP 404")) };

    expect(await testOnlyDiff(port, REPO, 1)).toMatchObject({ kind: "unread", reason: expect.stringContaining("could not be read at the default branch's merge base") });
  });

  it("fails closed when the merge base is not a commit sha", async () => {
    const fake = sceneFake([modified("packages/x/src/a.test.ts")], { branchConfig: REPO_CONFIG });
    fake.compares.set(`main...${HEAD}`, { mergeBaseSha: "main", files: [] });

    expect(await testOnlyDiff(githubPort(fake.wire), REPO, 1)).toMatchObject({ kind: "unread", reason: expect.stringContaining("not a commit sha") });
  });

  it("fails closed on a list at GitHub's file cap", async () => {
    const files = Array.from({ length: PR_FILES_CAP }, (_, n) => modified(`packages/x/src/t${n}.test.ts`));

    const diff = await testOnlyDiff(scene(files), REPO, 1);

    expect(diff).toMatchObject({ kind: "unread", reason: expect.stringContaining("file list cap") });
  });

  it("fails closed when GitHub lists fewer files than the PR reports", async () => {
    const port = scene([modified("packages/x/src/a.test.ts")], { changedFiles: 2 });

    expect(await testOnlyDiff(port, REPO, 1)).toMatchObject({ kind: "unread" });
  });

  it("fails closed when the base config cannot be read", async () => {
    const port: GitHubPort = { ...scene([modified("packages/x/src/a.test.ts")]), getFile: () => Promise.reject(new Error("HTTP 502")) };

    expect(await testOnlyDiff(port, REPO, 1)).toMatchObject({ kind: "unread", reason: expect.stringContaining(`${CONFIG_PATH} could not be read`) });
  });

  it("fails closed when the base config does not parse", async () => {
    const port = scene([modified("packages/x/src/a.test.ts")], { baseConfig: JSON.stringify({ tests: ["**/*.test.ts"], extra: true }) });

    expect(await testOnlyDiff(port, REPO, 1)).toMatchObject({ kind: "unread", reason: expect.stringContaining("unknown config key") });
  });

  it("fails closed on a path that would split the name-status line", async () => {
    const port = scene([modified("packages/x/src/a.test.ts\nA\tpackages/x/src/b.test.ts")]);

    expect(await testOnlyDiff(port, REPO, 1)).toMatchObject({ kind: "unread" });
  });

  it.each([
    ["an unknown file status", [{ path: "packages/x/src/a.test.ts", status: "unchanged" }]],
    ["a rename without its old path", [{ path: "packages/x/src/a.test.ts", status: "renamed" }]],
    ["an empty file list", []],
  ])("fails closed on %s", async (_name, files: PrFile[]) => {
    expect(await testOnlyDiff(scene(files), REPO, 1)).toMatchObject({ kind: "unread" });
  });

  it("fails closed when the registration names no PR", async () => {
    expect(await testOnlyDiff(scene([]), REPO, null)).toMatchObject({ kind: "unread" });
  });
});
