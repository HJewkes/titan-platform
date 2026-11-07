import { fakeGitHub, githubPort } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import type { GitCachePorts } from "../shepherd/carry-cache-ports.js";
import { landPrRoutes } from "./land-pr.js";

const SETTLE_INPUT = { repo: "acme/widgets", baseRef: "main", headSha: "a".repeat(40), waitMs: 0, boundMs: 0 };

describe("land-pr merge-tree read", () => {
  it("the merge-tree read reaches git through the land deps' ports", async () => {
    const calls: string[][] = [];
    const gitCache: GitCachePorts = {
      git: async (_dir, args) => (calls.push([...args]), { code: 1, stdout: "", stderr: "refused" }),
      fs: { exists: () => true, mkdirp: () => undefined },
      stateDir: () => "/synthetic/state",
    };
    const routes = landPrRoutes({ port: githubPort(fakeGitHub().wire), now: () => 0, sleep: async () => undefined, gitCache });
    const settle = routes.find((route) => route.match === "merge-settle")!;

    const outcome = await settle.runner.run({ runId: "run-1", workflowName: "land-pr", stepId: "merge-settle", iteration: 0, attempt: 1, requestKey: "k", prompt: JSON.stringify(SETTLE_INPUT), signal: new AbortController().signal });

    expect(calls.map((args) => args[0])).toContain("fetch");
    expect(JSON.stringify(outcome)).toContain("unread: git fetch exited 1");
  });
});
