import { CONFIG_PATH } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, type PrFile } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { supportOnlyDiff, testOnlyDiff } from "./test-only-diff.js";
import { onlyTestEntriesChanged } from "./tsconfig-test-support.js";

const REPO = "o/r";
const HEAD = fakeSha("head");
const MERGE_BASE = fakeSha("merge-base");
const CONFIG = JSON.stringify({ tests: ["packages/*/src/**/*.test.ts"], carry: ["**/test-support/**"] });
const TSCONFIG = "packages/x/tsconfig.typecheck.json";
const modified = (path: string): PrFile => ({ path, status: "modified" });

function sceneWith(files: PrFile[], before: string, after: string) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, baseRef: "main" });
  fake.prFiles.set(1, files);
  fake.compares.set(`main...${HEAD}`, { mergeBaseSha: MERGE_BASE, files: [] });
  for (const ref of [MERGE_BASE, "main"]) fake.files.set(`${ref}:${CONFIG_PATH}`, { content: CONFIG, blobSha: fakeSha(CONFIG) });
  for (const file of files) {
    const isConfig = file.path === TSCONFIG;
    fake.files.set(`${HEAD}:${file.path}`, { content: isConfig ? after : "blob", blobSha: fakeSha(`h:${file.path}`) });
    fake.files.set(`${MERGE_BASE}:${file.path}`, { content: isConfig ? before : "blob", blobSha: fakeSha(`b:${file.path}`) });
  }
  return githubPort(fake.wire);
}

const tsconfig = (include: string[], extra: Record<string, unknown> = {}, exclude: string[] = []): string =>
  JSON.stringify({ compilerOptions: { strict: true }, include, exclude, ...extra });

describe("a tsconfig change beside a test", () => {
  const files = [modified("packages/x/src/a.test.ts"), modified(TSCONFIG)];

  it("is test-only when it only adds a test path to exclude", async () => {
    const port = sceneWith(files, tsconfig(["src"]), tsconfig(["src"], {}, ["src/a.test.ts"]));

    expect(await testOnlyDiff(port, REPO, 1, HEAD)).toEqual({ kind: "test-only" });
  });

  it("stays source when it changes compilerOptions too", async () => {
    const port = sceneWith(files, tsconfig(["src"]), tsconfig(["src"], { compilerOptions: { strict: false } }, ["src/a.test.ts"]));

    expect(await testOnlyDiff(port, REPO, 1, HEAD)).toEqual({ kind: "source", paths: [TSCONFIG] });
  });

  it("stays source when it adds a non-test path to include", async () => {
    const port = sceneWith(files, tsconfig(["src"]), tsconfig(["src", "scripts/build.ts"]));

    expect(await testOnlyDiff(port, REPO, 1, HEAD)).toEqual({ kind: "source", paths: [TSCONFIG] });
  });

  it("stays source when the head file is not JSON", async () => {
    const port = sceneWith(files, tsconfig(["src"]), "{ not json");

    expect(await testOnlyDiff(port, REPO, 1, HEAD)).toEqual({ kind: "source", paths: [TSCONFIG] });
  });

  it("reads a tsconfig-only change as test support for a test-only registration", async () => {
    const port = sceneWith([modified(TSCONFIG)], tsconfig(["src"], {}, ["a.test.ts"]), tsconfig(["src"]));

    expect(await supportOnlyDiff(port, REPO, 1, HEAD)).toBe(true);
  });
});

describe("onlyTestEntriesChanged", () => {
  it("tolerates comments and trailing commas", () => {
    const before = '{\n // base\n "include": ["src"], /* x */ "exclude": ["a.test.ts",],\n}';
    const after = '{ "include": ["src"], "exclude": [] }';

    expect(onlyTestEntriesChanged(before, after)).toBe(true);
  });

  it("reads a comment marker inside a string as text", () => {
    const text = '{ "compilerOptions": { "paths": { "@/*": ["//x"] } }, "exclude": [] }';

    expect(onlyTestEntriesChanged(text, text.replace("[]", '["a.test.ts"]'))).toBe(true);
  });

  it("refuses an include list that appears where there was none", () => {
    expect(onlyTestEntriesChanged("{}", '{ "include": ["a.test.ts"] }')).toBe(false);
  });

  it("refuses a diff that changes nothing", () => {
    expect(onlyTestEntriesChanged("{}", "{}")).toBe(false);
  });
});
