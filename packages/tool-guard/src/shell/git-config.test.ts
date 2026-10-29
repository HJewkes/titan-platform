import { describe, expect, it } from "vitest";
import { extractCommands } from "./commands.js";
import { parseGit } from "./git.js";
import { isPushShapingKey, pushConfig } from "./git-config.js";

const REPO = "/home/you/projects/app";

function configOf(src: string) {
  const [cmd] = extractCommands(src, { cwd: REPO, home: "/home/you" }).filter((c) => c.name === "git");
  return pushConfig(parseGit(cmd?.args ?? [], REPO));
}

const NOTHING = { all: false, unknown: false, specs: [], upstream: false, merges: new Map() };

describe("pushConfig reads the push-shaping config a command passes itself", () => {
  it.each([
    ["a remote push refspec", "git -c remote.origin.push=refs/heads/feat:refs/heads/main push", ["refs/heads/feat:refs/heads/main"]],
    ["a key in any case", "git -c Remote.origin.PUSH=feat:main push", ["feat:main"]],
    ["every remote push refspec, in order", "git -c remote.a.push=x:y -c remote.b.push=HEAD push", ["x:y", "HEAD"]],
  ])("%s", (_name, src, specs) => {
    expect(configOf(src)).toEqual({ ...NOTHING, specs });
  });

  it.each([
    ["a mirror remote with no value", "git -c remote.origin.mirror push"],
    ["a mirror remote set true", "git -c remote.origin.mirror=true push"],
    ["a mirror remote set to a number", "git -c remote.origin.mirror=2 push"],
    ["push.default=matching", "git -c push.default=matching push"],
    ["a glob push refspec", "git -c 'remote.origin.push=refs/heads/*:refs/heads/*' push"],
    ["the matching refspec", "git -c remote.origin.push=: push"],
  ])("%s pushes every branch", (_name, src) => {
    expect(configOf(src).all).toBe(true);
  });

  it.each([
    ["mirror off", "git -c remote.origin.mirror=false push"],
    ["mirror off as NO", "git -c remote.origin.mirror=NO push"],
    ["mirror empty", "git -c remote.origin.mirror= push"],
  ])("%s does not mirror", (_name, src) => {
    expect(configOf(src)).toEqual(NOTHING);
  });

  it("reads push.default=upstream with the branch upstreams given beside it", () => {
    const config = configOf("git -c push.default=upstream -c branch.feat.merge=refs/heads/main push");

    expect(config).toEqual({ ...NOTHING, upstream: true, merges: new Map([["feat", "refs/heads/main"]]) });
  });

  it("keeps a branch subsection's case, as git does", () => {
    expect(configOf("git -c BRANCH.Feat.Merge=main push").merges).toEqual(new Map([["Feat", "main"]]));
  });

  it("follows the last push.default for upstream", () => {
    expect(configOf("git -c push.default=upstream -c push.default=current push").upstream).toBe(false);
  });

  it.each([
    ["--config-env on a remote push refspec", "git --config-env=remote.origin.push=V push"],
    ["--config-env as two words", "git --config-env remote.origin.push=V push"],
    ["--config-env on push.default", "git --config-env push.default=V push"],
    ["--config-env on a run-time key", 'git --config-env "$K=V" push'],
    ["an included file", "git -c include.path=/tmp/x push"],
    ["a conditionally included file", "git -c includeIf.gitdir:/a/.path=/tmp/x push"],
    ["a run-time remote push value", 'git -c "remote.origin.push=$V" push'],
    ["a run-time key", 'git -c "$K" push'],
    ["a run-time subsection", 'git -c "branch.$B.merge=main" push'],
    ["a push.default this reader does not know", "git -c push.default=Matching push"],
    ["a push.default with no value", "git -c push.default push"],
  ])("%s reads as unknown", (_name, src) => {
    expect(configOf(src).unknown).toBe(true);
  });

  it.each([
    ["an unrelated key", "git -c user.name=x push"],
    ["an unrelated run-time value", 'git -c "user.name=$N" push'],
    ["an unrelated --config-env", "git --config-env user.name=V push"],
    ["push.default=current", "git -c push.default=current push"],
    ["push.default=simple", "git -c push.default=simple push"],
    ["a push remote choice", "git -c remote.pushDefault=fork -c branch.feat.pushRemote=fork push"],
  ])("%s shapes nothing", (_name, src) => {
    expect(configOf(src)).toEqual(NOTHING);
  });
});

describe("isPushShapingKey", () => {
  it.each([
    ["remote.origin.push", true],
    ["remote.my.fork.mirror", true],
    ["branch.feat/x.merge", true],
    ["push.default", true],
    ["include.path", true],
    ["includeif.onbranch:main.path", true],
    ["remote.push", false],
    ["push.followtags", false],
    ["branch.feat.remote", false],
    ["user.name", false],
  ])("%s: %s", (key, shapes) => {
    expect(isPushShapingKey(key)).toBe(shapes);
  });
});
