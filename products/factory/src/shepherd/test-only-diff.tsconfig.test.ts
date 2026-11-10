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

describe("onlyTestEntriesChanged string handling", () => {
  it("reads a comma-bracket inside a compilerOptions string as text, so its change stays source", () => {
    const before = '{ "compilerOptions": { "outDir": "dist,}" }, "exclude": [] }';
    const after = '{ "compilerOptions": { "outDir": "dist}" }, "exclude": ["a.test.ts"] }';

    expect(onlyTestEntriesChanged(before, after)).toBe(false);
  });

  it("reads a changed path string holding a comma-bracket as source", () => {
    const before = '{ "compilerOptions": { "paths": { "x": ["a ]"] } }, "exclude": [] }';
    const after = '{ "compilerOptions": { "paths": { "x": ["a, ]"] } }, "exclude": ["a.test.ts"] }';

    expect(onlyTestEntriesChanged(before, after)).toBe(false);
  });

  it("refuses any comment, since tsc and JSON.parse could disagree on where it ends", () => {
    expect(onlyTestEntriesChanged('{ "exclude": ["a.test.ts"] // c\n}', '{ "exclude": [] }')).toBe(false);
  });

  it("refuses a trailing comma", () => {
    expect(onlyTestEntriesChanged('{ "exclude": ["a.test.ts",] }', '{ "exclude": [] }')).toBe(false);
  });

  it("refuses an unterminated block comment", () => {
    expect(onlyTestEntriesChanged('{ "exclude": [] }', '{ "exclude": ["a.test.ts"] } /* open')).toBe(false);
  });

  it.each(["\r", "\u2028", "\u2029"])("refuses a text with the line break %j that tsc ends a comment at", (lineBreak) => {
    const before = '{ "compilerOptions": {"strict": true}, "exclude": [] }';
    const after = `{ "compilerOptions": {"strict": true}, "exclude": ["a.test.ts"] // c${lineBreak}, "compilerOptions": {"strict": false}\n }`;

    expect(onlyTestEntriesChanged(before, after)).toBe(false);
  });

  it("refuses a repeated compilerOptions key whose last value differs", () => {
    const before = '{ "compilerOptions": {"strict": true}, "exclude": [] }';
    const after = '{ "compilerOptions": {"strict": true}, "exclude": ["a.test.ts"], "compilerOptions": {"strict": false} }';

    expect(onlyTestEntriesChanged(before, after)).toBe(false);
  });

  it("reads the same key in sibling objects as no repeat", () => {
    const text = '{ "a": { "x": 1 }, "b": { "x": 1 }, "exclude": [] }';

    expect(onlyTestEntriesChanged(text, text.replace("[]", '["a.test.ts"]'))).toBe(true);
  });
});

describe("a build tsconfig.json", () => {
  it("stays source even when only a test path changes", async () => {
    const build = "packages/x/tsconfig.json";
    const port = sceneWith([modified("packages/x/src/a.test.ts"), modified(build)], tsconfig(["src"]), tsconfig(["src"], {}, ["src/a.test.ts"]));

    expect(await testOnlyDiff(port, REPO, 1, HEAD)).toEqual({ kind: "source", paths: [build] });
  });
});
