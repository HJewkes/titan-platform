import { describe, expect, it } from "vitest";
import { tokenize } from "../shell/lexer.js";
import type { WordToken } from "../shell/lexer.js";
import { GH_PLACEHOLDER_RE, decodeGraphqlEscapes, graphqlBranchWrites } from "./graphql-branch-writes.js";

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
    ["updatePullRequestBranch", 'mutation{updatePullRequestBranch(input:{pullRequestId:"p"}){pullRequest{number}}}'],
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
    ["createLinkedBranch", 'mutation{createLinkedBranch(input:{issueId:"I",oid:"x",name:"main"}){linkedBranch{ref{name}}}}'],
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
    const body = String.raw`{"query":"mutation{updateRefs(input:{repositoryId:\"r\",refUpdates:[{name:\"refs/heads/\u006dain\",afterOid:\"x\"}]}){clientMutationId}}"}`;
    expect(graphqlBranchWrites([body], []).branches).toContain("main");
  });

  it("reads a mutation name hidden behind \\u escapes", () => {
    expect(read(String.raw`mutation{\u0075pdateRef(input:{refId:"R",oid:"x"}){clientMutationId}}`)).toMatchObject({ mutations: ["updateRef"], unknown: true });
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

  const commitOn = (branch: string, rest = 'message:{headline:"m"}') =>
    `mutation{createCommitOnBranch(input:{branch:${branch},${rest},expectedHeadOid:"x"}){commit{oid}}}`;
  const BY_INPUT = "mutation($i:CreateCommitOnBranchInput!){createCommitOnBranch(input:$i){commit{oid}}}";

  it.each([
    ["by id", [commitOn('{id:"R"}')], ""],
    ["by an id that spells a branch", [commitOn('{id:"REF_main"}')], ""],
    ["by id beside a feature branchName", [commitOn('{id:"R",branchName:"feat/x"}')], ""],
    ["by id while a comment names branchName", [`# branchName: feat/x\n${commitOn('{id:"R"}')}`], ""],
    ["by id while the headline says branchName", [commitOn('{id:"R"}', 'message:{headline:"set branchName"}')], ""],
    ["by id with commas and a comment before the colon", [commitOn('{id , # c\n : "R"}')], ""],
    ["by id in a JSON variables object", [`{"query":${JSON.stringify(commitOn("$b"))},"variables":{"b":{"id":"R"}}}`], ""],
    ["by id in a nested -F field", [commitOn("$b")], "-F b[id]=R -F b[branchName]=feat/x"],
    ["with no branch key at all", [commitOn("$b")], "-f note=branchName"],
    ["by id two levels deep in a -F field", [BY_INPUT], "-F i[branch][id]=REF_main"],
    ["by deep id beside an aliased branchName selection", [BY_INPUT.replace("commit{oid}", "branchName:commit{oid}")], "-F i[branch][id]=REF_main"],
    ["by deep id while a comment names branchName", [`# branchName:\n${BY_INPUT}`], "-F i[branch][id]=REF_main"],
    ["by deep id beside a branchName field", [BY_INPUT], "-F i[branch][id]=REF_main -f branchName=feat/x"],
    ["by deep id in an array element", [BY_INPUT], "-F i[branch][][id]=REF_main -f i[branch][branchName]=feat/x"],
  ])("reads createCommitOnBranch %s as unknown", (_how, texts, vars) => {
    expect(graphqlBranchWrites(texts, words(vars))).toMatchObject({ mutations: ["createCommitOnBranch"], unknown: true });
  });

  it("reads createLinkedBranch with no name as unknown", () => {
    expect(read('mutation{createLinkedBranch(input:{issueId:"I",oid:"x"}){linkedBranch{ref{name}}}}')).toMatchObject({
      mutations: ["createLinkedBranch"],
      unknown: true,
    });
  });

  it("reads createLinkedBranch with a feature name as known", () => {
    const result = read('mutation{createLinkedBranch(input:{issueId:"I",oid:"x",name:"feat/x"}){linkedBranch{ref{name}}}}');
    expect(result).toMatchObject({ unknown: false, branches: expect.arrayContaining(["feat/x"]) });
  });

  it("reads createCommitOnBranch on a feature branch as known", () => {
    expect(read(commitOn('{repositoryNameWithOwner:"o/r",branchName:"feat/x"}')).unknown).toBe(false);
  });

  it("reads createCommitOnBranch with a branchName two levels deep in a -F field as known", () => {
    const result = read(BY_INPUT, "-F i[branch][repositoryNameWithOwner]=o/r -F i[branch][branchName]=main");
    expect(result).toMatchObject({ unknown: false, branches: expect.arrayContaining(["main"]) });
  });

  const UPDATE_REFS_BY_VAR = "mutation($name:String!){updateRefs(input:{repositoryId:\"r\",refUpdates:[{name:$name,afterOid:\"x\"}]}){clientMutationId}}";

  it.each([
    ["a mergeBranch base", MERGE_BY_VAR, "-F 'base={branch}'"],
    ["a mergeBranch base with :branch inside a word", MERGE_BY_VAR, "-F base=m:branch"],
    ["a mergeBranch base with :branch before a dot", MERGE_BY_VAR, "-F base=:branch-1.0"],
    ["a mergeBranch base with {branch} after a prefix", MERGE_BY_VAR, "-F 'base=feature-{branch}'"],
    ["a mergeBranch base from {repo}", MERGE_BY_VAR, "-F 'base={repo}'"],
    ["a nested createCommitOnBranch branchName", BY_INPUT, "-F i[branch][repositoryNameWithOwner]=o/r -F 'i[branch][branchName]={branch}'"],
    ["an updateRefs name", UPDATE_REFS_BY_VAR, "-F 'name=refs/heads/{branch}'"],
  ])("reads %s gh fills from the checkout as unknown", (_what, query, vars) => {
    expect(read(query, vars).unknown).toBe(true);
  });

  it.each([
    ["{branch}", 'mutation{mergeBranch(input:{repositoryId:"r",base:"{branch}",head:"feat/x"}){mergeCommit{oid}}}'],
    [":branch", 'mutation{mergeBranch(input:{repositoryId:"r",base:":branch",head:"feat/x"}){mergeCommit{oid}}}'],
    ["refs/heads/{branch}", 'mutation{createRef(input:{repositoryId:"r",name:"refs/heads/{branch}",oid:"x"}){ref{id}}}'],
  ])("reads a query string %s gh fills from the checkout as unknown", (_what, query) => {
    expect(read(query).unknown).toBe(true);
  });

  it.each([
    ["between unquoted halves of a value", 'mutation{mergeBranch(input:{repositoryId:"r",head:"feat/x",base:{branch}main{branch}}){mergeCommit{oid}}}'],
    ["before the first quote", 'mutation{mergeBranch(input:{base:{branch},repositoryId:"r",head:"feat/x"}){mergeCommit{oid}}}'],
    ["after the last quote", 'mutation{mergeBranch(input:{repositoryId:"r",head:"feat/x",base:x:owner}){mergeCommit{oid}}}'],
    ["in a query with no quotes", "mutation{createRef(input:{repositoryId:{repo},name:{owner},oid:{branch}}){ref{id}}}"],
  ])("reads a placeholder %s of a -F query as unknown", (_where, query) => {
    expect(read(query).unknown).toBe(true);
  });

  it.each([
    ["a branch, which may hold any GraphQL text", "{viewer{login}}{branch}"],
    ["an owner that completes a name", 'mutation{update:repo(input:{refId:"R",oid:"x"}){clientMutationId}}'],
    ["an owner that is the whole mutation name", 'mutation{ {owner}(input:{repositoryId:"R",base:"main",head:"feat/x"}){mergeCommit{oid}} }'],
    ["a repo behind an alias", 'mutation{ a: {repo}(input:{repositoryId:"R",base:"main",head:"feat/x"}){mergeCommit{oid}} }'],
    ["an owner and repo joined into one name", 'mutation{ {owner}{repo}(input:{repositoryId:"R",base:"main",head:"feat/x"}){mergeCommit{oid}} }'],
    ["a colon-form owner as the name", 'mutation{ :owner(input:{repositoryId:"R",base:"main",head:"feat/x"}){mergeCommit{oid}} }'],
    ["an owner spliced into a read as the operation", '{owner}{ {repo}(input:{repositoryId:"R",base:"main",head:"feat/x"}){mergeCommit{oid}} }'],
  ])("reads a query with no mutation whose fill is %s as unknown", (_what, query) => {
    expect(read(query)).toMatchObject({ mutations: [], unknown: true });
  });

  it("reads even a read naming a quoted owner and repo as unknown, since any fill may rewrite the query", () => {
    expect(read('query{repository(owner:"{owner}",name:"{repo}"){defaultBranchRef{name}}}')).toEqual({ mutations: [], branches: [], unknown: true });
  });

  it("keeps a feature-branch mutation with a {name} selection gh leaves alone known", () => {
    expect(read('mutation{mergeBranch(input:{repositoryId:"r",base:"feat/x",head:"feat/y"}){mergeCommit{oid}}}').unknown).toBe(false);
  });

  it("pins gh 2.102's placeholder pattern", () => {
    expect(GH_PLACEHOLDER_RE.source).toBe(String.raw`:(?:owner|repo|branch)\b|\{[a-z]+\}`);
  });

  const FEATURE_MERGE = 'mutation{mergeBranch(input:{repositoryId:"r",base:"feat/x",head:"feat/y"}){mergeCommit{oid}}}';

  it.each([
    ["a command substitution", '-f "query$(printf x)=main"'],
    ["a backquote substitution", '-f "query`printf x`=main"'],
    ["a variable", '-f "query${X}=main"'],
  ])("reads a field whose key %s extends past query as an unreadable variable", (_how, vars) => {
    expect(read(FEATURE_MERGE, vars).unknown).toBe(true);
  });

  it("does not count a branchName key a substitution right before its = may change", () => {
    const vars = "-F i[branch][repositoryNameWithOwner]=o/r -F 'i[branch][branchName]'\"$(printf x)\"=feat/x";
    expect(read(BY_INPUT, vars).unknown).toBe(true);
  });

  it("keeps a feature branch whose name only resembles a placeholder known", () => {
    expect(read(MERGE_BY_VAR, "-F base=feat:branches").unknown).toBe(false);
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

  it("keeps a query field whose value, after its literal key, is dynamic out of the variables", () => {
    expect(graphqlBranchWrites(['mutation{mergeBranch(input:{base:"feat/x",head:"feat/y"}){mergeCommit{oid}}}'], words('query="$Q"')).unknown).toBe(false);
  });
});

describe("decodeGraphqlEscapes", () => {
  it.each([
    [String.raw`\u006dain`, "main"],
    [String.raw`\u{6d}ain`, "main"],
    [String.raw`refs\/heads\/main`, "refs/heads/main"],
    [String.raw`\"main\"`, '"main"'],
    [String.raw`\\u006dain`, "main"],
    [String.raw`a\nb`, "a\nb"],
    [String.raw`\u{110000}`, String.raw`\u{110000}`],
  ])("decodes %s", (text, decoded) => {
    expect(decodeGraphqlEscapes(text)).toEqual({ text: decoded, complete: true });
  });

  it("stops after the two layers GitHub decodes and says escapes are left", () => {
    expect(decodeGraphqlEscapes(String.raw`\u{5c}u{5c}u006dain`)).toEqual({ text: String.raw`\u006dain`, complete: false });
  });
});

describe("graphqlBranchWrites past the decode cap", () => {
  const DEEP = String.raw`\u{5c}u{5c}u0041`;

  it("keeps an opaque mutation beside a comment escaped past the cap", () => {
    const query = `mutation{updateRef(input:{refId:"R",oid:"x"}){clientMutationId}} # ${DEEP}`;
    expect(graphqlBranchWrites([query], [])).toMatchObject({ mutations: ["updateRef"], unknown: true });
  });

  it("reads a named mutation on a feature branch as unknown once a text is escaped past the cap", () => {
    const query = `mutation{mergeBranch(input:{base:"feat/x",head:"feat/y"}){mergeCommit{oid}}} # ${DEEP}`;
    expect(graphqlBranchWrites([query], [])).toMatchObject({ mutations: ["mergeBranch"], unknown: true });
  });

  it("reads a text with no mutation escaped past the cap as unknown", () => {
    expect(graphqlBranchWrites([`{viewer{login}} # ${DEEP}`], [])).toEqual({ mutations: [], branches: [], unknown: true });
  });
});

describe("graphqlBranchWrites cost on crafted texts", () => {
  /** Past this a hook timeout would let the command through; a linear reading of 64 KB takes milliseconds. */
  const BUDGET_MS = 500;
  const BS = "\\";
  const KB = 1024;

  function timed(texts: string[]) {
    const start = performance.now();
    const result = graphqlBranchWrites(texts, []);
    return { result, ms: performance.now() - start };
  }

  it("reads a 64 KB chain of escapes, each pass peeling one, as unknown within budget", () => {
    const link = `${BS}u{5c}`;
    const chain = `${link}${"u{5c}".repeat((32 * KB) / 5)}u006dain`;
    const padding = `${BS}u{110000}`.repeat((32 * KB) / 10);
    const { result, ms } = timed([`mutation{mergeBranch(input:{base:"${chain}${padding}"}){mergeCommit{oid}}}`]);
    expect(result.unknown).toBe(true);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("reads 64 KB of commented id keys within budget", () => {
    const { result, ms } = timed([`mutation{createCommitOnBranch(input:{branch:$b}){commit{oid}}}\n${"#id\n".repeat(16 * KB)}`]);
    expect(result.unknown).toBe(true);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
