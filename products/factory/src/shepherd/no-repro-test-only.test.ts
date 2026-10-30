import { CONFIG_PATH, formatResultLine, type FixProofResult } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, type GitHubPort, type PrFile } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { proceedsOnNoRepro } from "./no-repro-test-only.js";

const REPO = "o/r";
const HEAD = fakeSha("head");
const MERGE_BASE = fakeSha("merge-base");
const TEST_GLOBS = JSON.stringify({ tests: ["packages/*/src/**/*.test.ts"], carry: ["**/test-support/**", "**/fixtures/**"] });
const CHANGESET: PrFile = { path: ".changeset/quiet-tests.md", status: "added" };
const TEST: PrFile = { path: "packages/x/src/view.test.ts", status: "modified" };
const SPEC: PrFile = { path: "packages/x/src/view.test.mutations.json", status: "added" };
const SUPPORT: PrFile = { path: "packages/x/src/test-support/fake-port.ts", status: "modified" };
const FIXTURE: PrFile = { path: "packages/x/fixtures/fake.sh", status: "modified" };

/** A PR whose diff the fail-closed classifier can read in full: the merge base, the config at both ends and every changed blob. */
function scene(files: readonly PrFile[]): GitHubPort {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD });
  fake.prFiles.set(1, [...files]);
  fake.compares.set(`main...${HEAD}`, { mergeBaseSha: MERGE_BASE, files: [] });
  for (const ref of [MERGE_BASE, "main"]) fake.files.set(`${ref}:${CONFIG_PATH}`, { content: TEST_GLOBS, blobSha: fakeSha(`${ref}:config`) });
  for (const file of files) {
    if (file.status !== "removed") fake.files.set(`${HEAD}:${file.path}`, { content: "blob", blobSha: fakeSha(`head:${file.path}`) });
    if (file.status !== "added") fake.files.set(`${MERGE_BASE}:${file.path}`, { content: "blob", blobSha: fakeSha(`base:${file.path}`) });
  }
  return githubPort(fake.wire);
}

function vacuousLine(mutants?: FixProofResult["mutants"]): string {
  const counts: FixProofResult["counts"] = { reproduces: 0, "passes-on-base": 1, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
  return formatResultLine({ head: HEAD, mergeBase: MERGE_BASE, verdict: "vacuous", counts, notCollected: [], deletedTests: [], configEdited: false, tests: [], truncated: false, ...(mutants && { mutants }) });
}

function noTestsLine(): string {
  const counts: FixProofResult["counts"] = { reproduces: 0, "passes-on-base": 0, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
  return formatResultLine({ head: HEAD, mergeBase: MERGE_BASE, verdict: "no-tests", counts, notCollected: [], deletedTests: [], configEdited: false, tests: [], truncated: false });
}

const gate = (kind: string) => ({ flag: "on" as const, kind, repo: REPO, pr: 1, head: HEAD });

describe("proceedsOnNoRepro on a diff of tests and a changeset", () => {
  it("lets a correctness registration proceed, since its diff makes it test-only for proof", async () => {
    expect(await proceedsOnNoRepro(scene([TEST, CHANGESET]), gate("correctness"), vacuousLine())).toBe(true);
  });

  it("keeps a security registration gated", async () => {
    expect(await proceedsOnNoRepro(scene([TEST, CHANGESET]), gate("security"), vacuousLine())).toBe(false);
  });

  it("keeps a correctness registration gated once the diff also changes source", async () => {
    const files = [TEST, CHANGESET, { path: "packages/x/src/view.ts", status: "modified" } as const];

    expect(await proceedsOnNoRepro(scene(files), gate("correctness"), vacuousLine())).toBe(false);
  });

  it("keeps a correctness registration gated when its mutation spec is refused", async () => {
    const refused = vacuousLine({ verdict: "error", results: [], error: "mutants: spec refused" });

    expect(await proceedsOnNoRepro(scene([TEST, SPEC, CHANGESET]), gate("correctness"), refused)).toBe(false);
  });
});

describe("proceedsOnNoRepro on a diff of test support with no test in it (TP-4573)", () => {
  const SUPPORT_DIFF = [SUPPORT, FIXTURE, CHANGESET];

  it("lets a test-only registration proceed on its no-tests proof", async () => {
    expect(await proceedsOnNoRepro(scene(SUPPORT_DIFF), gate("test-only"), noTestsLine())).toBe(true);
  });

  it("keeps a correctness registration gated", async () => {
    expect(await proceedsOnNoRepro(scene(SUPPORT_DIFF), gate("correctness"), noTestsLine())).toBe(false);
  });

  it("keeps a security registration gated", async () => {
    expect(await proceedsOnNoRepro(scene(SUPPORT_DIFF), gate("security"), noTestsLine())).toBe(false);
  });

  it("keeps a test-only registration gated when the diff also changes source", async () => {
    const files = [...SUPPORT_DIFF, { path: "packages/x/src/view.ts", status: "modified" } as const];

    expect(await proceedsOnNoRepro(scene(files), gate("test-only"), noTestsLine())).toBe(false);
  });

  it("keeps a test-only registration gated when the diff deletes a test", async () => {
    const files = [...SUPPORT_DIFF, { path: "packages/x/src/view.test.ts", status: "removed" } as const];

    expect(await proceedsOnNoRepro(scene(files), gate("test-only"), noTestsLine())).toBe(false);
  });

  it("keeps a test-only registration gated when a changed blob does not read inline", async () => {
    const port: GitHubPort = { ...scene(SUPPORT_DIFF), getFile: (repo, path, ref) => (path === SUPPORT.path ? Promise.resolve(null) : scene(SUPPORT_DIFF).getFile(repo, path, ref)) };

    expect(await proceedsOnNoRepro(port, gate("test-only"), noTestsLine())).toBe(false);
  });

  it("keeps a test-only registration gated when the flag is off", async () => {
    expect(await proceedsOnNoRepro(scene(SUPPORT_DIFF), { ...gate("test-only"), flag: "off" }, noTestsLine())).toBe(false);
  });
});
