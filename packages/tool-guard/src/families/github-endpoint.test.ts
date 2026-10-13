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
  ])("a URL whose host or GitHub API path is known only at run time may reach GitHub: %s", (url) => {
    expect(mayReachGitHubApi(urlWord(url))).toBe(true);
  });

  it.each([
    ["https://api.github.com/repos/o/r/pulls/1/merge"],
    ["https://example.com/x"],
    ['"https://example.com/$P"'],
    ['"http://localhost:8080/$P"'],
    ['"http://127.0.0.1/$P"'],
  ])("a literal URL, or a literal non-GitHub host with a run-time path, is left alone: %s", (url) => {
    expect(mayReachGitHubApi(urlWord(url))).toBe(false);
  });
});
