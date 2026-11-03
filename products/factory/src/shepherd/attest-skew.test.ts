import type { GhExec } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { DIRTY_SUFFIX, UNKNOWN_BUILD_SHA } from "../build-info.js";
import { deploySkew } from "./attest-skew.js";

const REPO = "octo/factory";
const BUILD = "b".repeat(40);

/** A `gh compare` answer in COMPARE_JQ's shape: the commit count, the file count, then each path. */
function compared(ahead: number, files: readonly string[], listed = files.length): { exec: GhExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GhExec = async (args) => (calls.push([...args]), { code: 0, stdout: `${ahead}\n${listed}\n${files.join("\n")}\n`, stderr: "" });
  return { exec, calls };
}

const skewOf = (exec: GhExec, sha = BUILD) => deploySkew({ sha, repo: REPO, exec });

describe("deploy skew for the attest read (TP-4752)", () => {
  it("waits while main holds a commit the build lacks that changes a registry path", async () => {
    const { exec } = compared(2, ["docs/a.md", "products/factory/src/registry/attestations/7.json"]);

    expect(await skewOf(exec)(REPO)).toMatch(/^deploy skew: main is 2 commit\(s\) ahead of build b+, changing 1 registry path\(s\) such as products\/factory\/src\/registry\/attestations\/7\.json/);
  });

  it("waits on a closure.lock.json change outside the registry directory", async () => {
    const { exec } = compared(1, ["packages/demo/closure.lock.json"]);

    expect(await skewOf(exec)(REPO)).toMatch(/registry path/);
  });

  it("judges at once when main's commits the build lacks change no registry path", async () => {
    const { exec } = compared(3, ["products/factory/src/serve.ts", "products/factory/src/registryish.ts"]);

    expect(await skewOf(exec)(REPO)).toBeUndefined();
  });

  it("judges at once when the build holds main", async () => {
    const { exec } = compared(0, [], 0);

    expect(await skewOf(exec)(REPO)).toBeUndefined();
  });

  it("waits when the compare could not be read, never judging on a failed read", async () => {
    const exec: GhExec = async () => ({ code: 1, stdout: "", stderr: "HTTP 502" });

    expect(await skewOf(exec)(REPO)).toMatch(/^deploy skew unread against build b+: gh compare failed \(1\)/);
  });

  it("waits when the compare lists fewer files than it changed", async () => {
    const { exec } = compared(1, ["docs/a.md"], 2);

    expect(await skewOf(exec)(REPO)).toMatch(/does not list every changed file/);
  });

  it("waits when the running build has no sha", async () => {
    const { exec, calls } = compared(0, [], 0);

    expect(await skewOf(exec, UNKNOWN_BUILD_SHA)(REPO)).toMatch(/has no sha/);
    expect(calls).toEqual([]);
  });

  it("compares a dirty build from its base commit", async () => {
    const { exec, calls } = compared(0, [], 0);

    await skewOf(exec, `${BUILD}${DIRTY_SUFFIX}`)(REPO);

    expect(calls[0]).toContain(`repos/${REPO}/compare/${BUILD}...main`);
  });

  it("reads no skew for another repo's PR, whose attestations this build's registry does not lay out", async () => {
    const { exec, calls } = compared(1, ["products/factory/src/registry/attestations/7.json"]);

    expect(await skewOf(exec)("octo/other")).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
