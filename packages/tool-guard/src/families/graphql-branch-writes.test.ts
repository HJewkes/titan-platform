import { describe, expect, it } from "vitest";
import { tokenize } from "../shell/lexer.js";
import type { WordToken } from "../shell/lexer.js";
import { decodeGraphqlEscapes, graphqlBranchWrites } from "./graphql-branch-writes.js";

const words = (src: string) => tokenize(src).filter((t): t is WordToken => t.type === "word");

/** Reads a `gh api graphql` call whose query is `query` and whose other field words are `vars`, written as shell text. */
function read(query: string, vars = "") {
  return graphqlBranchWrites([query], [...words(`'query=${query}'`), ...words(vars)]);
}

describe("graphqlBranchWrites, mutations whose target is opaque", () => {
  it.each([
    ["updateRef", 'mutation{updateRef(input:{refId:"R",oid:"x"}){clientMutationId}}'],
    ["deleteRef", 'mutation{deleteRef(input:{refId:"R"}){clientMutationId}}'],
    ["enqueuePullRequest", 'mutation{enqueuePullRequest(input:{pullRequestId:"p"}){mergeQueueEntry{id}}}'],
  ])("%s reads as an unknown branch", (name, query) => {
    expect(read(query)).toMatchObject({ mutations: [name], unknown: true });
  });
});

describe("graphqlBranchWrites, mutations that name their branch", () => {
  it.each([
    ["updateRefs", 'mutation{updateRefs(input:{repositoryId:"r",refUpdates:[{name:"refs/heads/main",afterOid:"x"}]}){clientMutationId}}'],
    ["createRef", 'mutation{createRef(input:{repositoryId:"r",name:"refs/heads/main",oid:"x"}){ref{id}}}'],
    ["mergeBranch", 'mutation{mergeBranch(input:{repositoryId:"r",base:"main",head:"feat/x"}){mergeCommit{oid}}}'],
    ["createCommitOnBranch", 'mutation{createCommitOnBranch(input:{branch:{repositoryNameWithOwner:"o/r",branchName:"main"},message:{headline:"m"},expectedHeadOid:"x"}){commit{oid}}}'],
  ])("%s on main lists main and stays known", (name, query) => {
    const result = read(query);
    expect(result).toMatchObject({ mutations: [name], unknown: false });
    expect(result.branches).toContain("main");
  });

  it.each([
    ["updateRefs", 'mutation{updateRefs(input:{repositoryId:"r",refUpdates:[{name:"refs/heads/feat/x",afterOid:"x"}]}){clientMutationId}}'],
    ["mergeBranch", 'mutation{mergeBranch(input:{repositoryId:"r",base:"feat/x",head:"feat/y"}){mergeCommit{oid}}}'],
  ])("%s naming only feature branches lists no protected name", (_name, query) => {
    const result = read(query);
    expect(result.unknown).toBe(false);
    expect(result.branches.filter((b) => /^(?:main|master|release\/.+)$/.test(b))).toEqual([]);
  });

  it("keeps a release branch's slash", () => {
    expect(read('mutation{createRef(input:{repositoryId:"r",name:"refs/heads/release/2.0",oid:"x"}){ref{id}}}').branches).toContain("release/2.0");
  });

  it("reads a branch written with \\u escapes, as an --input body would carry it", () => {
    const body = String.raw`{"query":"mutation{updateRefs(input:{repositoryId:\"r\",refUpdates:[{name:\"refs/heads/main\",afterOid:\"x\"}]}){clientMutationId}}"}`;
    expect(graphqlBranchWrites([body], []).branches).toContain("main");
  });

  it("reads a mutation name hidden behind \\u escapes", () => {
    expect(read(String.raw`mutation{updateRef(input:{refId:"R",oid:"x"}){clientMutationId}}`)).toMatchObject({ mutations: ["updateRef"], unknown: true });
  });

  it("reads a mutation name after an escaped newline in a JSON body", () => {
    expect(graphqlBranchWrites([String.raw`{"query":"mutation{\nmergeBranch(input:{base:\"main\"}){mergeCommit{oid}}}"}`], []).branches).toContain("main");
  });

  it("reads a branch in a block string", () => {
    expect(read('mutation{mergeBranch(input:{repositoryId:"r",base:"""main""",head:"feat/x"}){mergeCommit{oid}}}').branches).toContain("main");
  });

  it("reads a branch a comment's stray quote would misalign", () => {
    const query = 'mutation{ # "\n mergeBranch(input:{repositoryId:"r",base:"main",head:"feat/x"}){mergeCommit{oid}}}';
    expect(graphqlBranchWrites([query], []).branches).toContain("main");
  });
});

describe("graphqlBranchWrites, variables", () => {
  const MERGE_BY_VAR = "mutation($base:String!){mergeBranch(input:{repositoryId:\"r\",base:$base,head:\"feat/x\"}){mergeCommit{oid}}}";

  it("reads a base given by -f base=main", () => {
    expect(read(MERGE_BY_VAR, "-f base=main").branches).toContain("main");
  });

  it.each([
    ["read from a file", "-F base=@f"],
    ["set at run time", '-f base="$B"'],
    ["under a run-time key", '-f "$K"=main'],
    ["from a command substitution", "-f base=`cat b`"],
  ])("reads a base %s as unknown", (_how, vars) => {
    expect(read(MERGE_BY_VAR, vars).unknown).toBe(true);
  });

  it("reads createCommitOnBranch by branch id as unknown", () => {
    const query = 'mutation{createCommitOnBranch(input:{branch:{id:"R"},message:{headline:"m"},expectedHeadOid:"x"}){commit{oid}}}';
    expect(read(query)).toMatchObject({ mutations: ["createCommitOnBranch"], unknown: true });
  });

  it("reads createCommitOnBranch whose branchName comes from a nested field", () => {
    const query = "mutation($branch:CommittableBranch!){createCommitOnBranch(input:{branch:$branch,message:{headline:\"m\"},expectedHeadOid:\"x\"}){commit{oid}}}";
    expect(read(query, "-F branch[branchName]=main -F branch[repositoryNameWithOwner]=o/r")).toMatchObject({ unknown: false, branches: expect.arrayContaining(["main"]) });
  });
});

describe("graphqlBranchWrites, calls that write no branch", () => {
  it.each([
    ["a viewer read", "{viewer{login}}"],
    ["a mergeable read", "query{repository(owner:\"o\",name:\"r\"){pullRequest(number:1){mergeable}}}"],
    ["a field named mergeBranchX", "query{mergeBranchX}"],
  ])("%s gives nothing", (_what, query) => {
    expect(read(query, '-f x="$X"')).toEqual({ mutations: [], branches: [], unknown: false });
  });

  it("does not read updateRefs as updateRef", () => {
    const result = read('mutation{updateRefs(input:{repositoryId:"r",refUpdates:[{name:"refs/heads/feat/x",afterOid:"x"}]}){clientMutationId}}');
    expect(result).toMatchObject({ mutations: ["updateRefs"], unknown: false });
  });

  it("does not read a dynamic query field as an unknown variable", () => {
    expect(graphqlBranchWrites(['mutation{mergeBranch(input:{base:"feat/x",head:"feat/y"}){mergeCommit{oid}}}'], words('query="$Q"')).unknown).toBe(false);
  });
});

describe("decodeGraphqlEscapes", () => {
  it.each([
    [String.raw`main`, "main"],
    [String.raw`\u{6d}ain`, "main"],
    [String.raw`refs\/heads\/main`, "refs/heads/main"],
    [String.raw`\"main\"`, '"main"'],
    [String.raw`\\u006dain`, "main"],
    [String.raw`a\nb`, "a\nb"],
    [String.raw`\u{110000}`, String.raw`\u{110000}`],
  ])("decodes %s", (text, decoded) => {
    expect(decodeGraphqlEscapes(text)).toBe(decoded);
  });
});
