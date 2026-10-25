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
    ["bash.release.git-push-tag", "git push origin v1", "git"],
    ["bash.release.git-push-tag", "git push origin refs/tags/v1", "git"],
    ["bash.release.git-push-tag", "git push --tags", "git"],
    ["bash.release.git-push-tag", "git push --follow-tags", "git"],
    ["bash.release.git-push-tag", "git push origin tag release-candidate", "git"],
    ["bash.release.git-push-tag", "git push origin +v1.2.0", "git"],
    ["bash.release.git-push-tag", "git push origin :refs/tags/v1", "git"],
    ["bash.release.git-push-tag", "git push origin --delete v1", "git"],
    ["bash.release.git-push-tag", "git push origin HEAD:tags/stable", "git"],
    ["bash.release.git-push-tag", "git push origin refs/tags/nightly:", "git"],
    ["bash.release.git-push-tag", "git -c push.followTags push origin feat/x", "git"],
    ["bash.release.git-push-tag", "git -c push.followtags=true push", "git"],
    ["bash.release.git-push-tag", "git push origin @titan-design/tool-guard@1.2.3", "git"],
    ["bash.release.git-push-tag", "git push origin --delete @titan-design/x@1.0.0", "git"],
    ["bash.release.git-push-tag", "git push origin pkg@2.0.0", "git"],
    ["bash.release.git-push-tag", "git push origin 1.2.0", "git"],
    ["bash.release.git-push-tag", "git push --tag origin", "git"],
    ["bash.release.git-push-tag", "git push --follow origin feat/x", "git"],
    ["bash.release.git-push-tag", "git push --fol origin feat/x", "git"],
    ["bash.release.git-push-tag", "git push --del origin v1", "git"],
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
    "git push origin feat/x",
    "git push -u origin HEAD",
    "git push origin vendor-fix",
    "git push origin feat/v1:refs/heads/feat/v1",
    "git push origin v1:feat/x",
    "git push origin refs/heads/v2-migration",
    "git push origin refs/tags/v1:refs/heads/feat/x",
    "git push origin tag",
    "git push --no-follow-tags origin feat/x",
    "git push --no-fol origin feat/x",
    "git push --fo origin feat/x",
    "git push origin rc1",
    "git push origin feat/node-1.2",
    "git -c push.followTags=false push origin feat/x",
    "git tag v1",
  ])("%s", (command) => {
    expect(bash(command)).toEqual([]);
  });
});

describe("a name the local repository holds as a tag", () => {
  const tagged: ClassifyContext = { ...ctx, isTag: (dir, name) => dir === REPO && name === "rc1" };
  const push = (command: string) => classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, tagged).map((a) => a.spelling);
  const TAG = "bash.release.git-push-tag";
  const MAYBE = "bash.release.git-push-maybe-tag";

  it.each(["git push origin rc1", "git push origin -d rc1", "git push origin HEAD:rc1", "git push origin +rc1:rc1", "git push origin rc1:feat/x"])("reads `%s` as a tag push", (command) => {
    expect(push(command)).toEqual([TAG]);
  });

  it.each(["git push origin rc1:refs/heads/feat/x", "git push origin feat/rc1", "git push origin HEAD:feat/x", "git push origin HEAD~1:refs/heads/feat/x"])("does not read `%s` as a tag push", (command) => {
    expect(push(command)).toEqual([]);
  });

  it.each([
    ["git tag deploy-1 && git push origin deploy-1"],
    ["git tag -a nightly -m x; git push origin nightly"],
    ["git tag -f nightly HEAD && git push -f origin nightly"],
    ["git tag --annotate --message=x nightly || true; git push origin nightly"],
    ["git tag -d nightly; git push origin :nightly"],
    ["git update-ref refs/tags/nightly HEAD && git push origin nightly"],
    ["git checkout -b feat/y && git tag nightly && git push origin nightly"],
    ["git checkout -b feat/y && git tag nightly; git push origin nightly"],
  ])("reads a tag the line itself writes as a tag: `%s`", (command) => {
    expect(push(command)).toEqual([TAG]);
  });

  it.each([
    ['git tag "$T" && git push origin nightly'],
    ["git update-ref --stdin < refs.txt; git push origin nightly"],
    ['git -C "$D" push origin rc1'],
    ['git -C "$D" push origin feat/x'],
    ['cd "$X" && git push origin rc1'],
    ["git --git-dir=.git push origin rc1"],
    ["git --work-tree=. push origin feat/x"],
  ])("reads a name it cannot look up as a possible tag: `%s`", (command) => {
    expect(push(command)).toEqual([MAYBE]);
  });

  it.each([
    ["git tag -l nightly; git push origin nightly"],
    ["git tag --contains HEAD nightly; git push origin nightly"],
    ["git tag; git push origin nightly"],
    ["git tag other && git push origin nightly"],
    ["git push origin nightly; git tag nightly"],
    ['git -C "$D" push origin HEAD:refs/heads/feat/x'],
    ['git -C "$D" push origin HEAD:feat/x'],
  ])("does not read `%s` as a tag push", (command) => {
    expect(push(command)).toEqual([]);
  });
});

describe("a tag push beside a branch push", () => {
  it("keeps the protected branch verdict next to the tag push", () => {
    expect(bash("git push --follow-tags origin HEAD:main").map((a) => a.spelling)).toEqual(["bash.release.git-push-tag", "bash.merge.git-push-protected"]);
  });

  it("reads a v-named source sent to a protected branch as the branch push only", () => {
    expect(bash("git push origin v1:main").map((a) => a.spelling)).toEqual(["bash.merge.git-push-protected"]);
  });
});
