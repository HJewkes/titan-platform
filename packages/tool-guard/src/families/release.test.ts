import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifiedAction, ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";
const ctx: ClassifyContext = { home: "/home/you", readLink: () => null, readHead: () => "feat/x", readScript: () => null };

function bash(command: string): ClassifiedAction[] {
  return classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, ctx);
}

describe("one fixture per bash.release spelling", () => {
  it.each([
    ["bash.release.npm-publish", "npm publish", "npm"],
    ["bash.release.npm-publish", "npm pub --tag next", "npm"],
    ["bash.release.npm-publish", "npm -w packages/a publish --access public", "npm"],
    ["bash.release.pnpm-publish", "pnpm publish --no-git-checks", "pnpm"],
    ["bash.release.pnpm-publish", "pnpm -r publish", "pnpm"],
    ["bash.release.pnpm-publish", "pnpm --filter @scope/a publish", "pnpm"],
    ["bash.release.pnpm-publish", "pnpm -F a publish", "pnpm"],
    ["bash.release.yarn-bun-publish", "yarn publish", "yarn"],
    ["bash.release.yarn-bun-publish", "yarn npm publish", "yarn"],
    ["bash.release.yarn-bun-publish", "bun publish", "bun"],
    ["bash.release.changeset-publish", "changeset publish", "changeset"],
    ["bash.release.changeset-publish", "pnpm changeset publish", "changeset"],
    ["bash.release.changeset-publish", "npx changeset publish", "changeset"],
    ["bash.release.changeset-publish", "pnpm exec changeset publish", "changeset"],
    ["bash.release.changeset-publish", "pnpm dlx @changesets/cli publish", "@changesets/cli"],
    ["bash.release.npm-registry-mutation", "npm dist-tag add @scope/a@1.2.0 latest", "npm"],
    ["bash.release.npm-registry-mutation", "npm dist-tag rm @scope/a next", "npm"],
    ["bash.release.npm-registry-mutation", "npm unpublish @scope/a@1.2.0", "npm"],
    ["bash.release.npm-registry-mutation", "npm deprecate @scope/a@1 'use 2'", "npm"],
    ["bash.release.gh-release", "gh release create v1.0.0 --notes x", "gh"],
    ["bash.release.gh-release", "gh release upload v1.0.0 dist.tgz", "gh"],
    ["bash.release.gh-release", "gh release delete v1.0.0 -y", "gh"],
    ["bash.release.gh-workflow-run", "gh workflow run release.yml", "gh"],
    ["bash.release.gh-workflow-run", "gh workflow run Release --ref main", "gh"],
    ["bash.release.gh-workflow-run", "gh workflow run publish.yml", "gh"],
    ["bash.release.gh-workflow-run", "gh workflow run 123456", "gh"],
    ["bash.release.gh-workflow-run", 'gh workflow run "$WORKFLOW"', "gh"],
    ["bash.release.wrangler-deploy", "wrangler deploy", "wrangler"],
    ["bash.release.wrangler-deploy", "npx wrangler publish", "wrangler"],
    ["bash.release.wrangler-deploy", "pnpm exec wrangler versions deploy", "wrangler"],
    ["bash.release.wrangler-deploy", "pnpm dlx wrangler deploy --env production", "wrangler"],
    ["bash.release.version-packages-merge", "gh pr merge changeset-release/main --squash", "gh"],
  ])("%s: %s", (spelling, command, tool) => {
    expect(bash(command)).toEqual([expect.objectContaining({ action: "release", spelling, subject: { tool } })]);
  });
});

describe("the Version Packages branch", () => {
  it("classifies a merge naming changeset-release/main as release and one by number as merge", () => {
    expect(bash("gh pr merge changeset-release/main --merge").map((a) => a.action)).toEqual(["release"]);
    expect(bash("gh pr merge 12").map((a) => a.action)).toEqual(["merge"]);
  });
});

describe("normal work classifies nothing", () => {
  it.each([
    "npm view @scope/a versions",
    "npm dist-tag ls @scope/a",
    "npm pack --dry-run",
    "pnpm build && pnpm test",
    "pnpm --filter a test",
    "pnpm changeset",
    "pnpm changeset status",
    "pnpm publish-docs",
    "gh release list",
    "gh release view v1.0.0",
    "gh workflow run ci.yml",
    "gh workflow view release.yml",
    "wrangler dev",
    "npx wrangler tail",
    "git commit -m 'npm publish after review'",
  ])("%s", (command) => {
    expect(bash(command)).toEqual([]);
  });
});
