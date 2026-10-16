import { describe, expect, it } from "vitest";
import type { GhExec } from "./exec.js";
import { fakeGitHub, fakeSha } from "./fake.js";
import { ghCliWire } from "./gh-cli.js";
import { githubPort } from "./port.js";

const REPO = "octo/demo";
const prBody = (state: string, merged: boolean) =>
  JSON.stringify({ number: 7, state, merged, merge_commit_sha: "test-merge", draft: false, mergeable_state: "clean", head: { ref: "topic", sha: fakeSha("head1") }, base: { ref: "main" } });

function scriptedGh(state: string, merged: boolean): { exec: GhExec; calls: { args: readonly string[]; input?: string }[] } {
  const calls: { args: readonly string[]; input?: string }[] = [];
  const exec: GhExec = async (args, input) => {
    calls.push({ args, input });
    const stdout = args.join(" ").includes("compare/") ? JSON.stringify({ behind_by: 0 }) : prBody(state, merged);
    return { code: 0, stdout, stderr: "" };
  };
  return { exec, calls };
}

describe("closePr", () => {
  it("sends one PATCH of pulls/{pr} whose body carries state closed and nothing else", async () => {
    const gh = scriptedGh("open", false);

    const result = await githubPort(ghCliWire(gh.exec)).closePr(REPO, 7);

    const writes = gh.calls.filter((call) => call.args.includes("PATCH"));
    expect(result).toEqual({ done: true });
    expect(writes.map((call) => call.args)).toEqual([["api", "-i", "-X", "PATCH", "repos/octo/demo/pulls/7", "--input", "-"]]);
    expect(JSON.parse(writes[0]!.input!)).toEqual({ state: "closed" });
  });

  it("sends no PATCH for a PR that is already closed or merged", async () => {
    for (const [state, merged, skipped] of [["closed", false, "closed"], ["closed", true, "merged"]] as const) {
      const gh = scriptedGh(state, merged);

      const result = await githubPort(ghCliWire(gh.exec)).closePr(REPO, 7);

      expect(result).toEqual({ done: false, skipped });
      expect(gh.calls.some((call) => call.args.includes("PATCH"))).toBe(false);
    }
  });

  it("reads back as closed over the fake, and a repeat skips", async () => {
    const fake = fakeGitHub();
    const pr = fake.addPr({ headSha: fakeSha("head1") });
    const port = githubPort(fake.wire);

    const first = await port.closePr(REPO, pr.number);
    const again = await port.closePr(REPO, pr.number);

    expect(first).toEqual({ done: true });
    expect(again).toEqual({ done: false, skipped: "closed" });
    expect((await port.getPr(REPO, pr.number)).state).toBe("closed");
  });

  it("refuses a bad PR number before any call", async () => {
    const gh = scriptedGh("open", false);

    await expect(githubPort(ghCliWire(gh.exec)).closePr(REPO, 0)).rejects.toThrow(/pr/);
    expect(gh.calls).toEqual([]);
  });
});
