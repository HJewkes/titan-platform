import { CONFIG_PATH, formatResultLine, type FixProofResult } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, type GitHubPort, type PrFile } from "@titan-design/github";

const REPO = "o/r";
const HEAD = fakeSha("head");
const MERGE_BASE = fakeSha("merge-base");
const TEST_GLOBS = JSON.stringify({ tests: ["packages/*/src/**/*.test.ts"], carry: ["**/test-support/**", "**/fixtures/**"] });
export const CHANGESET: PrFile = { path: ".changeset/quiet-tests.md", status: "added" };
export const TEST: PrFile = { path: "packages/x/src/view.test.ts", status: "modified" };
export const SPEC: PrFile = { path: "packages/x/src/view.test.mutations.json", status: "added" };
export const SUPPORT: PrFile = { path: "packages/x/src/test-support/fake-port.ts", status: "modified" };
export const FIXTURE: PrFile = { path: "packages/x/fixtures/fake.sh", status: "modified" };

/** A PR whose diff the fail-closed classifier can read in full: the merge base, the config at both ends and every changed blob. */
export function scene(files: readonly PrFile[]): GitHubPort {
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

function line(verdict: FixProofResult["verdict"], passesOnBase: number, mutants?: FixProofResult["mutants"]): string {
  const counts: FixProofResult["counts"] = { reproduces: 0, "passes-on-base": passesOnBase, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
  return formatResultLine({ head: HEAD, mergeBase: MERGE_BASE, verdict, counts, notCollected: [], deletedTests: [], configEdited: false, tests: [], truncated: false, ...(mutants && { mutants }) });
}

export const vacuousLine = (mutants?: FixProofResult["mutants"]): string => line("vacuous", 1, mutants);
export const noTestsLine = (): string => line("no-tests", 0);

export const gate = (kind: string) => ({ flag: "on" as const, kind, repo: REPO, pr: 1, head: HEAD });
