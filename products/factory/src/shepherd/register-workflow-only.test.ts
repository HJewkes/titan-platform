import { CONFIG_PATH } from "@titan-design/fix-proof";
import { fakeSha, type PrFile } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture } from "../test-support/shepherd.js";
import type { Registered } from "./commands.js";
import { TEST_ONLY_HINT, WORKFLOW_ONLY_HINT } from "./register-kind.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const MERGE_BASE = fakeSha("merge-base");
const CONFIG = JSON.stringify({ tests: ["{packages,products,apps}/*/src/**/*.test.{ts,tsx}"], carry: ["**/test-support/**"] });
const pr1 = { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" };
const added = (path: string): PrFile => ({ path, status: "added" });
const WORKFLOW_ONLY = [added(".github/workflows/ci.yml"), added(".changeset/demo.md")];
const WORKFLOW_WITH_SOURCE = [added(".github/workflows/ci.yml"), added("products/demo/src/x.ts")];
const TESTS_ONLY = [added(".changeset/demo.md"), added("products/demo/src/x.test.ts")];

async function register(files: PrFile[], args: object): Promise<Registered> {
  const fixture = shepherdFixture({ frozen: true });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  fixture.fake.prFiles.set(1, files);
  fixture.fake.compares.set(`main...${H1}`, { mergeBaseSha: MERGE_BASE, files: [] });
  for (const ref of [MERGE_BASE, "main"]) fixture.fake.files.set(`${ref}:${CONFIG_PATH}`, { content: CONFIG, blobSha: fakeSha(ref) });
  for (const { path } of files) fixture.fake.files.set(`${H1}:${path}`, { content: "blob", blobSha: fakeSha(path) });
  const envelope = await callCommand<Registered>(host, fixture.routes, "shepherd.register", args);
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data;
}

describe("shepherd register hints at a non-fix-proof kind for a workflow-only diff", () => {
  it.each(["correctness", "security"])("hints on a %s registration", async (kind) => {
    expect(await register(WORKFLOW_ONLY, { ...pr1, kind })).toMatchObject({ kindHint: WORKFLOW_ONLY_HINT });
  });

  it("hints on a defaulted registration", async () => {
    expect(await register(WORKFLOW_ONLY, pr1)).toMatchObject({ registration: { kind: "correctness" }, kindHint: WORKFLOW_ONLY_HINT });
  });

  it("says the proof needs a red required check at the merge base, the kind cannot leave, and to register feature or refactor", () => {
    expect(WORKFLOW_ONLY_HINT).toContain("only when a required check is red at the merge base");
    expect(WORKFLOW_ONLY_HINT).toContain("NO_REPRO");
    expect(WORKFLOW_ONLY_HINT).toContain("cannot later leave the fix-proof kinds");
    expect(WORKFLOW_ONLY_HINT).toContain("--kind feature or refactor on its first register");
  });

  it.each(["feature", "refactor"])("gives no hint on a %s registration", async (kind) => {
    expect(await register(WORKFLOW_ONLY, { ...pr1, kind })).not.toHaveProperty("kindHint");
  });

  it("gives no hint when the diff also changes source", async () => {
    expect(await register(WORKFLOW_WITH_SOURCE, pr1)).not.toHaveProperty("kindHint");
  });

  it("keeps the test-only hint on a tests-only diff", async () => {
    expect(await register(TESTS_ONLY, pr1)).toMatchObject({ kindHint: TEST_ONLY_HINT });
  });
});
