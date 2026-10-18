import { CONFIG_PATH } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, PR_FILES_CAP, type GitHubPort, type PrFile } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { MAX_PROBED_PATHS, testOnlyDiff } from "./test-only-diff.js";

const REPO = "o/r";
const REPO_CONFIG = JSON.stringify({
  tests: ["{packages,products,apps}/*/src/**/*.test.{ts,tsx}", "apps/*/{scripts,server}/**/*.test.ts", "scripts/**/*.test.mjs"],
  carry: ["**/fixtures/**", "**/__fixtures__/**", "**/test-support/**", "**/testdata/**", "**/*.test-helpers.ts", "**/*.fixture.ts"],
});

const modified = (path: string): PrFile => ({ path, status: "modified" });
const removed = (path: string): PrFile => ({ path, status: "removed" });

const HEAD = fakeSha("head");
const MERGE_BASE = fakeSha("merge-base");
const LOOSE_CONFIG = JSON.stringify({ tests: ["**/*.test.ts"], carry: ["**/*.ts"] });

// Paths that are source under the repo config but test-only under the plan's wider built-in globs.
const DEFAULTS_ONLY_TESTS = ["packages/x/test/evil.test.ts", "packages/x/src/hook.spec.ts", "products/factory/vitest.setup.test.js"];

/** `baseConfig` sits at the merge base, `tipConfig` (default: the same) at main's tip, `parentConfig` at a non-main base ref. */
type SceneOptions = { baseConfig?: string | null; tipConfig?: string | null; changedFiles?: number; baseRef?: string; parentConfig?: string };

function seedConfig(fake: ReturnType<typeof fakeGitHub>, ref: string, content: string | null): void {
  if (content !== null) fake.files.set(`${ref}:${CONFIG_PATH}`, { content, blobSha: fakeSha(content) });
}

function seedBlob(fake: ReturnType<typeof fakeGitHub>, ref: string, path: string): void {
  fake.files.set(`${ref}:${path}`, { content: "blob", blobSha: fakeSha(`${ref}:${path}`) });
}

/** Each listed path's blob where GitHub would hold it: a modified file at both ends, an added one at the head, a removed one at the merge base. */
function seedBlobs(fake: ReturnType<typeof fakeGitHub>, files: readonly PrFile[]): void {
  for (const file of files) {
    if (file.status !== "removed") seedBlob(fake, HEAD, file.path);
    if (file.status !== "added" && file.status !== "renamed" && file.status !== "copied") seedBlob(fake, MERGE_BASE, file.path);
    if (file.status === "renamed" && file.previousPath !== undefined) seedBlob(fake, MERGE_BASE, file.previousPath);
  }
}

function sceneFake(files: PrFile[], options: SceneOptions = {}) {
  const fake = fakeGitHub();
  const baseRef = options.baseRef ?? "main";
  fake.addPr({ headSha: HEAD, baseRef });
  fake.prFiles.set(1, files);
  if (options.changedFiles !== undefined) fake.prChangedFiles.set(1, options.changedFiles);
  fake.compares.set(`main...${HEAD}`, { mergeBaseSha: MERGE_BASE, files: [] });
  const baseConfig = options.baseConfig === undefined ? REPO_CONFIG : options.baseConfig;
  seedConfig(fake, MERGE_BASE, baseConfig);
  seedConfig(fake, "main", options.tipConfig === undefined ? baseConfig : options.tipConfig);
  if (options.parentConfig !== undefined) seedConfig(fake, baseRef, options.parentConfig);
  seedBlobs(fake, files);
  return fake;
}

const scene = (files: PrFile[], options: SceneOptions = {}) => githubPort(sceneFake(files, options).wire);
const testAndSource = [modified("packages/x/src/a.test.ts"), modified("packages/x/src/x.ts")];
const RUNTIME_CONFIG = JSON.stringify({ ...JSON.parse(REPO_CONFIG), runtime: ["packages/agent-protocol/fixtures/**", "apps/console/fixtures/**"] });

/** A port whose contents read of `path` at `ref` fails the way gh-cli does on an entry GitHub returns without inline base64. */
function gitlinkAt(port: GitHubPort, path: string, ref: string): GitHubPort {
  return {
    ...port,
    getFile: (repo, read, at) => (read === path && at === ref ? Promise.reject(new Error(`${path} is undefined-encoded; only files GitHub returns inline are supported`)) : port.getFile(repo, read, at)),
  };
}

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
    const port = scene(testAndSource, { baseRef: "parent", parentConfig: LOOSE_CONFIG });

    const diff = await testOnlyDiff(port, REPO, 1);

    expect(diff).toMatchObject({ kind: "unread", reason: expect.stringMatching(/"parent".*"main"/) });
  });

  it("does not let a wider tip config widen the merge-base config", async () => {
    const port = scene(testAndSource, { tipConfig: LOOSE_CONFIG });

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "source", paths: ["packages/x/src/x.ts"] });
  });

  it("does not let a fork point's wider config widen the tip's", async () => {
    const port = scene(testAndSource, { baseConfig: LOOSE_CONFIG, tipConfig: REPO_CONFIG });

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "source", paths: ["packages/x/src/x.ts"] });
  });

  it("does not let a fork point that predates the config fall back to the wider defaults", async () => {
    const port = scene(DEFAULTS_ONLY_TESTS.map(modified), { baseConfig: null, tipConfig: REPO_CONFIG });

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "source", paths: [...DEFAULTS_ONLY_TESTS].sort() });
  });

  it("uses the built-in globs when neither the merge base nor the tip has a config", async () => {
    const port = scene([modified("packages/x/src/a.test.ts")], { baseConfig: null });

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "test-only" });
  });

  it("fails closed when the tip config cannot be read", async () => {
    const healthy = scene([modified("packages/x/src/a.test.ts")]);
    const port: GitHubPort = { ...healthy, getFile: (repo, path, ref) => (ref === "main" ? Promise.reject(new Error("HTTP 502")) : healthy.getFile(repo, path, ref)) };

    expect(await testOnlyDiff(port, REPO, 1)).toMatchObject({ kind: "unread", reason: expect.stringContaining(`${CONFIG_PATH} could not be read`) });
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
    const fake = sceneFake([modified("packages/x/src/a.test.ts")], { baseConfig: null, tipConfig: REPO_CONFIG });
    fake.compares.set(`main...${HEAD}`, { mergeBaseSha: "main", files: [] });

    expect(await testOnlyDiff(githubPort(fake.wire), REPO, 1)).toMatchObject({ kind: "unread", reason: expect.stringContaining("not a commit sha") });
  });

  it("flags a changeset-only PR", async () => {
    const port = scene([{ path: ".changeset/x.md", status: "added" }]);

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "flagged", reason: "the PR adds or changes no test", paths: [] });
  });

  it("flags a PR that deletes a test and names it", async () => {
    const port = scene([{ path: "products/factory/src/a.test.ts", status: "added" }, removed("products/factory/src/b.test.ts")]);

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({
      kind: "flagged",
      reason: "the PR deletes tests products/factory/src/b.test.ts",
      paths: ["products/factory/src/b.test.ts"],
    });
  });

  it("flags a diff that has no test under one of the two configs", async () => {
    const port = scene([modified("packages/x/src/a.test.ts")], { tipConfig: JSON.stringify({ ...JSON.parse(REPO_CONFIG), tests: ["apps/**/*.test.ts"], carry: ["**/*.test.ts"] }) });

    expect(await testOnlyDiff(port, REPO, 1)).toMatchObject({ kind: "flagged", reason: "the PR adds or changes no test" });
  });

  it("reads a published fixture as source under a runtime glob", async () => {
    const port = scene([modified("packages/x/src/a.test.ts"), modified("packages/agent-protocol/fixtures/round.json")], { baseConfig: RUNTIME_CONFIG });

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "source", paths: ["packages/agent-protocol/fixtures/round.json"] });
  });

  it("reads a gitlink under a carry path as unread", async () => {
    const files = [modified("packages/x/src/a.test.ts"), modified("packages/x/src/fixtures/vendor")];

    const diff = await testOnlyDiff(gitlinkAt(scene(files), "packages/x/src/fixtures/vendor", HEAD), REPO, 1);

    expect(diff).toEqual({ kind: "unread", reason: `"packages/x/src/fixtures/vendor" at ${HEAD} is not a regular file GitHub returns inline: a gitlink, a large file or a read error` });
  });

  it("reads a removed gitlink as unread", async () => {
    const files = [modified("packages/x/src/a.test.ts"), removed("packages/x/src/fixtures/vendor")];

    const diff = await testOnlyDiff(gitlinkAt(scene(files), "packages/x/src/fixtures/vendor", MERGE_BASE), REPO, 1);

    expect(diff).toMatchObject({ kind: "unread", reason: expect.stringContaining(`"packages/x/src/fixtures/vendor" at ${MERGE_BASE}`) });
  });

  it("reads a rename's old gitlink as unread", async () => {
    const files: PrFile[] = [modified("packages/x/src/a.test.ts"), { path: "packages/x/src/fixtures/new", previousPath: "packages/x/src/fixtures/old", status: "renamed" }];

    const diff = await testOnlyDiff(gitlinkAt(scene(files), "packages/x/src/fixtures/old", MERGE_BASE), REPO, 1);

    expect(diff).toMatchObject({ kind: "unread", reason: expect.stringContaining(`"packages/x/src/fixtures/old" at ${MERGE_BASE}`) });
  });

  it("reads a removed carry file from the merge base, where it still exists", async () => {
    const port = scene([modified("packages/x/src/a.test.ts"), removed("packages/x/src/fixtures/old.json")]);

    expect(await testOnlyDiff(port, REPO, 1)).toEqual({ kind: "test-only" });
  });

  it("reads a listed path with no blob at the head as unread", async () => {
    const fake = sceneFake([modified("packages/x/src/a.test.ts"), modified("packages/x/src/fixtures/a.json")]);
    fake.files.delete(`${HEAD}:packages/x/src/fixtures/a.json`);

    expect(await testOnlyDiff(githubPort(fake.wire), REPO, 1)).toMatchObject({ kind: "unread", reason: expect.stringContaining('"packages/x/src/fixtures/a.json"') });
  });

  it("refuses to probe past the path cap and makes no contents call for it", async () => {
    const fake = sceneFake(Array.from({ length: MAX_PROBED_PATHS + 1 }, (_, n) => modified(`packages/x/src/t${n}.test.ts`)));

    const diff = await testOnlyDiff(githubPort(fake.wire), REPO, 1);

    expect(diff).toMatchObject({ kind: "unread", reason: expect.stringContaining(`over the ${MAX_PROBED_PATHS}`) });
    expect(fake.calls.filter((call) => call === "getContent")).toHaveLength(2);
  });

  it("probes a diff at the path cap", async () => {
    const files = Array.from({ length: MAX_PROBED_PATHS }, (_, n) => modified(`packages/x/src/t${n}.test.ts`));

    expect(await testOnlyDiff(scene(files), REPO, 1)).toEqual({ kind: "test-only" });
  });

  it("fails closed when the PR's head is not a commit sha", async () => {
    const fake = sceneFake([modified("packages/x/src/a.test.ts")]);
    fake.pushHead(1, "feature");
    fake.compares.set("main...feature", { mergeBaseSha: MERGE_BASE, files: [] });
    seedBlob(fake, "feature", "packages/x/src/a.test.ts");

    expect(await testOnlyDiff(githubPort(fake.wire), REPO, 1)).toMatchObject({ kind: "unread", reason: "the PR's head is not a commit sha" });
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
