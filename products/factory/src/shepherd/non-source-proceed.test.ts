import { CONFIG_PATH, formatResultLine, type FixProofResult } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, successRun, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { FIX_PROOF_CHECK, readFixProof } from "./fix-proof.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { proofStandingAt } from "./proof-waiver.js";
import { shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";

const REPO = "octo/demo";
const H = fakeSha("non-source-head");
const MERGE_BASE = fakeSha("non-source-merge-base");
const JOB = 77;

/** A run that never waived, so its proof standing reads no waiver step. */
const unwaived = partialFake<WorkflowContext>({ iteration: () => 0 });

function vacuousLine(mutants?: FixProofResult["mutants"]): string {
  const counts: FixProofResult["counts"] = { reproduces: 0, "passes-on-base": 0, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
  return formatResultLine({ head: H, mergeBase: MERGE_BASE, base: "main", verdict: "vacuous", counts, notCollected: [], deletedTests: [], configEdited: false, tests: [], truncated: false, ...(mutants && { mutants }) });
}

type Flag = "keep-owner" | "record-fact" | undefined;
type Fake = ReturnType<typeof fakeGitHub>;

/** The repo's own fix-proof globs, runtime trees included, as the trusted config at the merge base and main's tip. */
const REPO_CONFIG = JSON.stringify({
  tests: ["{packages,products,apps}/*/src/**/*.test.{ts,tsx}"],
  carry: ["**/fixtures/**", "**/test-support/**", "**/*.test-helpers.ts"],
  runtime: ["apps/console/fixtures/**", ".github/**"],
});

function seedBlob(fake: Fake, ref: string, path: string): void {
  fake.files.set(`${ref}:${path}`, { content: "blob", blobSha: fakeSha(`${ref}:${path}`) });
}

/** The config, and each listed path's blob where GitHub holds it; `gitlinks` read as no inline blob. */
function seedDiffReads(fake: Fake, files: readonly PrFile[], gitlinks: readonly string[]): void {
  for (const ref of [MERGE_BASE, "main"]) fake.files.set(`${ref}:${CONFIG_PATH}`, { content: REPO_CONFIG, blobSha: fakeSha(REPO_CONFIG) });
  for (const file of files.filter((listed) => !gitlinks.includes(listed.path))) {
    if (file.status !== "removed") seedBlob(fake, H, file.path);
    if (file.status === "modified" || file.status === "removed") seedBlob(fake, MERGE_BASE, file.path);
    if (file.previousPath !== undefined) seedBlob(fake, MERGE_BASE, file.previousPath);
  }
}

/** A registered correctness run whose fix-proof is vacuous at H; a workflow-only diff reads CI instead, green at both commits. */
async function standingOf(files: PrFile[], flag: Flag, kind = "correctness", line = vacuousLine(), gitlinks: readonly string[] = []) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H });
  fake.prFiles.set(1, files);
  seedDiffReads(fake, files, gitlinks);
  const proofRun = { ...successRun(FIX_PROOF_CHECK, JOB), pullRequests: [{ number: 1, baseRef: "main" }] };
  fake.setRuns(H, [successRun("validate", 1), successRun("dag-check", 2), proofRun]);
  fake.jobLogs.set(JOB, `2026-10-11T12:00:00.0000000Z ${line}`);
  fake.compares.set(`main...${H}`, { mergeBaseSha: MERGE_BASE, files: [] });
  fake.setRuns(MERGE_BASE, [successRun("validate", 31), successRun("dag-check", 32)]);
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), sliceMigration(8)]);
  const store = shepherdStoreRef();
  store.bind(db);
  store.get().register({ repo: REPO, pr: 1, runId: "run-1", task: "demo: tidy", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind });
  const timing = { now: () => 0, sleep: async () => undefined, pollMs: 1_000, timeoutMs: 10_000 };
  const deps = { port: githubPort(fake.wire), store, ...(flag && { nonSourceNoRepro: flag }) };
  const read = await readFixProof(deps, { repo: REPO, head: H, runId: "run-1" }, timing, new AbortController().signal);
  return proofStandingAt(unwaived, H, read);
}

const TEST_CONVERSION: PrFile[] = [
  { path: "packages/x/src/__tests__/parse.test.ts", status: "added" },
  { path: "packages/x/src/parse.test.ts", status: "removed" },
  { path: "packages/x/src/__tests__/parse.test.mutations.json", status: "added" },
  { path: "packages/x/src/test-support/parse-cases.ts", status: "added" },
  { path: ".changeset/convert-parse-tests.md", status: "added" },
];
const WORKFLOW_ONLY: PrFile[] = [
  { path: ".github/workflows/ci.yml", status: "modified" },
  { path: ".changeset/pin-runner.md", status: "added" },
];
const NON_SOURCE = { standing: { unverified: "no-repro-non-source", proofBase: "main" } };

describe("shepherd.gateReset.nonSourceNoRepro (TP-4275)", () => {
  it.each([
    ["absent", undefined],
    ["keep-owner", "keep-owner"],
  ] as const)("ends a test-only conversion as NO_REPRO, for the owner's sent-back gate, when the key is %s", async (_, flag) => {
    expect(await standingOf(TEST_CONVERSION, flag)).toMatchObject({ ended: { kind: "NO_REPRO", headSha: H } });
  });

  it("records a test-only conversion's NO_REPRO as a fact and lets review proceed under record-fact", async () => {
    expect(await standingOf(TEST_CONVERSION, "record-fact")).toEqual(NON_SOURCE);
  });

  it("records a workflow-only diff's unproved CI read as a fact under record-fact", async () => {
    expect(await standingOf(WORKFLOW_ONLY, undefined)).toMatchObject({ ended: { kind: "NO_REPRO", result: { kind: "workflow-ci", proved: false } } });
    expect(await standingOf(WORKFLOW_ONLY, "record-fact")).toMatchObject({ standing: { unverified: "no-repro-non-source", reason: expect.stringContaining("only .github/workflows/") } });
  });

  it("keeps NO_REPRO under record-fact when one changed path is source", async () => {
    const files: PrFile[] = [...TEST_CONVERSION, { path: "packages/x/src/parse.ts", status: "modified" }];

    expect(await standingOf(files, "record-fact")).toMatchObject({ ended: { kind: "NO_REPRO" } });
  });

  it("keeps NO_REPRO under record-fact when a rename moves a source path out of the diff", async () => {
    const files: PrFile[] = [{ path: "packages/x/src/parse.test.ts", previousPath: "packages/x/src/parse.ts", status: "renamed" }];

    expect(await standingOf(files, "record-fact")).toMatchObject({ ended: { kind: "NO_REPRO" } });
  });

  const carried: [string, FixProofResult["mutants"]][] = [
    ["a surviving mutation", { verdict: "not-killed", results: [{ spec: "packages/x/src/parse.test.mutations.json", name: "drop the bound", outcome: "survived" }], uncovered: [] }],
    ["a refused mutation spec", { verdict: "error", results: [], error: "mutants: spec refused" }],
  ];
  it.each(carried)("keeps NO_REPRO under record-fact when the line carries %s", async (_, mutants) => {
    const line = vacuousLine(mutants);

    expect(await standingOf(TEST_CONVERSION, "record-fact", "correctness", line)).toMatchObject({ ended: { kind: "NO_REPRO" } });
  });

  it("keeps NO_REPRO for a security run under record-fact", async () => {
    expect(await standingOf(TEST_CONVERSION, "record-fact", "security")).toMatchObject({ ended: { kind: "NO_REPRO" } });
  });

  it.each([
    ["a changeset tool config", ".changeset/config.json"],
    ["source under a docs directory", "packages/x/src/docs/render.ts"],
    ["a helper outside the test and carry globs", "packages/x/src/a.test.helpers.ts"],
    ["a fixture in a runtime tree", "apps/console/fixtures/rounds/a.md"],
    ["a docs page", "site/guides/parse.md"],
  ])("keeps NO_REPRO under record-fact when the diff adds %s, which the fix-proof plan reads as source", async (_, path) => {
    const files: PrFile[] = [...TEST_CONVERSION, { path, status: "modified" }];

    expect(await standingOf(files, "record-fact")).toMatchObject({ ended: { kind: "NO_REPRO" } });
  });

  it("keeps NO_REPRO under record-fact when a carried path is not a regular file GitHub returns inline", async () => {
    const line = vacuousLine();

    expect(await standingOf(TEST_CONVERSION, "record-fact", "correctness", line, ["packages/x/src/test-support/parse-cases.ts"])).toMatchObject({ ended: { kind: "NO_REPRO" } });
  });

  it("records a diff that only deletes a test as a fact under record-fact, for the reviewer to judge", async () => {
    const files: PrFile[] = [{ path: "packages/x/src/parse.test.ts", status: "removed" }];

    expect(await standingOf(files, "record-fact")).toEqual(NON_SOURCE);
  });
});
