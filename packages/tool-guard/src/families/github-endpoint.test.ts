import { describe, expect, it } from "vitest";
import { extractCommands } from "../shell/commands.js";
import { mayReachGitHubApi } from "./github-endpoint.js";

function urlWord(url: string) {
  const curl = extractCommands(`curl -X PUT ${url}`).find((c) => c.name === "curl");
  const word = curl?.args.at(-1);
  if (!word) throw new Error(`no URL word in ${url}`);
  return word;
}

describe("mayReachGitHubApi", () => {
  it.each([
    ['"$U"'],
    ["$U"],
    ['"$(cat u)"'],
    ['"https://$H/x"'],
    ['"https://api.github.com$X/repos"'],
    ['"https://api.github.com/repos/$R/pulls/1/merge"'],
    ['"https://API.github.com/x?$Q"'],
    ['"https://example.com$(echo @api.github.com)/repos/o/r/pulls/1/merge"'],
    ['"https://example.com`echo @api.github.com`/repos/o/r/pulls/1/merge"'],
    ['"https://api.$(echo github).com/repos/o/r/pulls/1/merge"'],
    ['"https://$(echo api.github).com/repos/o/r/pulls/1/merge"'],
    ['"https://api.github.com./repos/$R/pulls/1/merge"'],
    ["https://api.{github,x}.com/repos/o/r/pulls/1/merge$R"],
    ['"https://api.github.{com,x}/repos/o/r/pulls/1/merge$R"'],
    ['"https://api.github.co[m-m]/repos/$R/pulls/1/merge"'],
    ['"https://${G}/repos/o/r/pulls/1/merge"'],
    ['"https://u:p@api.github.com/repos/$R/pulls/1/merge"'],
    ['"https://api.github.com:443/repos/$R/pulls/1/merge"'],
    ['"https://api%2Egithub.com/repos/$R/pulls/1/merge"'],
    ['"https://api\u3002github.com/repos/$R/pulls/1/merge"'],
    ["\"https://api\"$'\\x2e'\"github.com/repos/$R/pulls/1/merge\""],
    ['https://api.git"hub".com/repos/"$R"/pulls/1/merge'],
    ['https://api\\.github.com/repos/"$R"/pulls/1/merge'],
    ['"api.github.com/repos/$R/pulls/1/merge"'],
    ['"//api.github.com/repos/$R/pulls/1/merge"'],
  ])("a URL whose host or GitHub API path is known only at run time may reach GitHub: %s", (url) => {
    expect(mayReachGitHubApi(urlWord(url))).toBe(true);
  });

  it.each([
    ["https://api.github.com/repos/o/r/pulls/1/merge"],
    ["https://example.com/x"],
    ['"https://example.com/$P"'],
    ['"http://localhost:8080/$P"'],
    ['"http://127.0.0.1/$P"'],
    ['"http://[::1]:8080/$P"'],
    ['"https://api.github.com@example.com/$P"'],
    ['"example.com/$P"'],
  ])("a literal URL, or a literal non-GitHub host with a run-time path, is left alone: %s", (url) => {
    expect(mayReachGitHubApi(urlWord(url))).toBe(false);
  });
});
