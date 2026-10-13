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
    "https://api.github.com//graphql",
    "https://api.github.com/graphql.json",
    "https://api.github.com/%2Fgraphql",
    "https://api.github.com/graphql%20",
    "'https://api.github.com/graphql;x'",
  ])("names GitHub's GraphQL endpoint: %s", (url) => {
    expect(isGitHubGraphql(urlWord(url))).toBe(true);
  });

  it.each([
    "https://api.github.com/graphql2",
    "https://api.github.com/graphql-x",
    "https://api.github.com/v3/graphql",
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

  it.each([
    ["a comment", '{/*c*/"query":"mutation{mergePullRequest}"}'],
    ["a trailing comma", '{"query":"mutation{mergePullRequest}",}'],
    ["trailing garbage", '{"query":"mutation{mergePullRequest}"} garbage'],
    ["a leading space and comment", ' [/*c*/{"query":"mutation{mergePullRequest}"}]'],
  ])("reads JSON-looking text no strict parser takes, with %s, as unknowable", (_, body) => {
    expect(graphqlQueries([body])).toBeNull();
  });

  it("reads a JSON body joined with a second -d value as unknowable", () => {
    expect(graphqlQueries(['{"query":"mutation{mergePullRequest}"}', "x"])).toBeNull();
  });

  it("decodes a byte-order-marked JSON body", () => {
    expect(graphqlQueries(['\uFEFF{"query":"mutation{merge\\u0050ullRequest}"}'])).toContain("mutation{mergePullRequest}");
  });

  it("undoes JSON escapes in text that is not JSON", () => {
    expect(graphqlQueries(['x&{"query":"merge\\u0050ullRequest\\n"'])).toContain('x&{"query":"mergePullRequest\n"');
  });

  it("gives an empty body as one empty text", () => {
    expect(graphqlQueries([])).toEqual([""]);
  });
});
