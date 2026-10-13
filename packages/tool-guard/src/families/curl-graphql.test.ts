import { describe, expect, it } from "vitest";
import { extractCommands } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";
import { graphqlQueries, isGitHubGraphql } from "./curl-graphql.js";

function urlWord(url: string): WordToken {
  const [word] = extractCommands(`curl ${url}`)[0]?.args ?? [];
  if (!word) throw new Error(`no URL word in ${url}`);
  return word;
}

describe("isGitHubGraphql", () => {
  it.each([
    "https://api.github.com/graphql",
    "https://API.github.com/graphql/",
    "'https://api.github.com/graphql?x=1'",
    "api.github.com/graphql",
    "https://api.github.com/%67raphql",
  ])("names GitHub's GraphQL endpoint: %s", (url) => {
    expect(isGitHubGraphql(urlWord(url))).toBe(true);
  });

  it.each([
    "https://api.github.com/graphql2",
    "https://example.com/graphql",
    "https://api.github.com/repos/o/r",
    '"https://api.github.com/$P"',
  ])("does not name it: %s", (url) => {
    expect(isGitHubGraphql(urlWord(url))).toBe(false);
  });
});

describe("graphqlQueries", () => {
  it("passes an unknowable body through as null", () => {
    expect(graphqlQueries(null)).toBeNull();
  });

  it("gives a JSON body's raw text and its decoded query", () => {
    const body = '{"query":"mutation{mergePullRequest(input:{}){clientMutationId}}"}';
    expect(graphqlQueries([body])).toEqual([body, "mutation{mergePullRequest(input:{}){clientMutationId}}"]);
  });

  it("decodes an escaped query so the mutation name reads plainly", () => {
    const queries = graphqlQueries(['{"query":"mutation{merge\\u0050ullRequest}"}']);
    expect(queries).toContain("mutation{mergePullRequest}");
  });

  it("joins --json halves without a separator before decoding", () => {
    const queries = graphqlQueries(['{"query":"mutation{mergePull', 'Request}"}']);
    expect(queries).toContain("mutation{mergePullRequest}");
  });

  it("reads every query of a batch array", () => {
    const queries = graphqlQueries(['[{"query":"query{viewer{login}}"},{"query":"mutation{enablePullRequestAutoMerge}"}]']);
    expect(queries).toEqual(expect.arrayContaining(["query{viewer{login}}", "mutation{enablePullRequestAutoMerge}"]));
  });

  it("gives non-JSON text raw, in both joins", () => {
    expect(graphqlQueries(["a=1", "b=2"])).toEqual(["a=1&b=2", "a=1b=2"]);
  });

  it("gives an empty body as one empty text", () => {
    expect(graphqlQueries([])).toEqual([""]);
  });
});
