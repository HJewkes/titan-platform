import type { GitHubPort } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { proceedsOnNoRepro } from "./no-repro-test-only.js";
import { CHANGESET, FIXTURE, SUPPORT, gate, noTestsLine, scene } from "./no-repro-test-only.test-helpers.js";

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
