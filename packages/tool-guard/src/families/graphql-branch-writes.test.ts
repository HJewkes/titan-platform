import { describe, expect, it } from "vitest";
import { tokenize } from "../shell/lexer.js";
import type { WordToken } from "../shell/lexer.js";
import { GH_PLACEHOLDER_RE } from "./field-words.js";
import { decodeGraphqlEscapes, graphqlBranchWrites } from "./graphql-branch-writes.js";

const BS = "\\";
const PROTECTED_RE = /^(?:main|master|release\/.+)$/;
/** Two escape layers past what GitHub decodes. */
const DEEP = `${BS}u{5c}u{5c}u0041`;
const words = (src: string) => tokenize(src).filter((t): t is WordToken => t.type === "word");
/** Reads a `gh api graphql` call whose query is `query` and whose other field words are `vars`, written as shell text. */
const read = (query: string, vars = "") => graphqlBranchWrites([query], [...words(`'query=${query}'`), ...words(vars)]);

const merge = (base: string, head = '"feat/x"') => `mutation{mergeBranch(input:{repositoryId:"r",base:${base},head:${head}}){mergeCommit{oid}}}`;
const commitOn = (branch: string, rest = 'message:{headline:"m"}') =>
  `mutation{createCommitOnBranch(input:{branch:${branch},${rest},expectedHeadOid:"x"}){commit{oid}}}`;
const updateRefs = (name: string) => `mutation{updateRefs(input:{repositoryId:"r",refUpdates:[{name:${name},afterOid:"x"}]}){clientMutationId}}`;
const createRef = (name: string) => `mutation{createRef(input:{repositoryId:"r",name:${name},oid:"x"}){ref{id}}}`;
const MERGE_BY_VAR = `mutation($base:String!)${merge("$base").slice("mutation".length)}`;
const BY_INPUT = "mutation($i:CreateCommitOnBranchInput!){createCommitOnBranch(input:$i){commit{oid}}}";
const FEATURE_MERGE = merge('"feat/x"', '"feat/y"');
const LINKED = (name: string) => `mutation{createLinkedBranch(input:{issueId:"I",oid:"x"${name}}){linkedBranch{ref{name}}}}`;

describe("graphqlBranchWrites, mutations", () => {
  it.each([
    ["updateRef", 'mutation{updateRef(input:{refId:"R",oid:"x"}){clientMutationId}}'],
    ["deleteRef", 'mutation{deleteRef(input:{refId:"R"}){clientMutationId}}'],
    ["enqueuePullRequest", 'mutation{enqueuePullRequest(input:{pullRequestId:"p"}){mergeQueueEntry{id}}}'],
    ["updatePullRequestBranch", 'mutation{updatePullRequestBranch(input:{pullRequestId:"p"}){pullRequest{number}}}'],
    ["updateRef", `mutation{${BS}u0075pdateRef(input:{refId:"R",oid:"x"}){clientMutationId}}`],
    ["updateRef", `mutation{updateRef(input:{refId:"R",oid:"x"}){clientMutationId}} # ${DEEP}`],
  ])("%s with an opaque target reads unknown (row %#)", (name, query) => {
    expect(read(query)).toMatchObject({ mutations: [name], unknown: true });
  });

  it.each([
    ["updateRefs", updateRefs('"refs/heads/main"')],
    ["createRef", createRef('"refs/heads/main"')],
    ["mergeBranch", merge('"main"')],
    ["createCommitOnBranch", commitOn('{repositoryNameWithOwner:"o/r",branchName:"main"}')],
    ["createLinkedBranch", LINKED(',name:"main"')],
  ])("%s on main lists main and stays known", (name, query) => {
    expect(read(query)).toMatchObject({ mutations: [name], unknown: false, branches: expect.arrayContaining(["main"]) });
  });
});

describe("graphqlBranchWrites, known targets", () => {
  it.each([
    ["a feature updateRefs, not read as updateRef", updateRefs('"refs/heads/feat/x"'), "", "feat/x"],
    ["a feature mergeBranch with a {oid} selection gh leaves alone", FEATURE_MERGE, "", "feat/y"],
    ["a release branch's slash", createRef('"refs/heads/release/2.0"'), "", "release/2.0"],
    ["an escaped name in an --input body", `{"query":"${updateRefs(`${BS}"refs/heads/${BS}u006dain${BS}"`)}"}`, "", "main"],
    ["a name after an escaped newline in a JSON body", `{"query":"mutation{${BS}nmergeBranch(input:{base:${BS}"main${BS}"}){mergeCommit{oid}}}"}`, "", "main"],
    ["a block string", merge('"""main"""'), "", "main"],
    ["a name a comment's stray quote would misalign", `# "\n${merge('"main"')}`, "", "main"],
    ["a base given by -f base=main", MERGE_BY_VAR, "-f base=main", "main"],
    ["a wholly quoted glob, which the shell leaves alone", MERGE_BY_VAR, "-f 'base=mai?'", "mai?"],
    ["a name only resembling a placeholder", MERGE_BY_VAR, "-F base=feat:branches", "feat:branches"],
    ["a query field whose value, after its literal key, is dynamic", FEATURE_MERGE, '-f query="$Q"', "feat/y"],
    ["createLinkedBranch on a feature", LINKED(',name:"feat/x"'), "", "feat/x"],
    ["createCommitOnBranch on a feature", commitOn('{repositoryNameWithOwner:"o/r",branchName:"feat/y"}'), "", "feat/y"],
    ["a quoted nested branchName", BY_INPUT, "-F 'i[branch][repositoryNameWithOwner]=o/r' -F 'i[branch][branchName]=main'", "main"],
  ])("reads %s as known", (_what, query, vars, branch) => {
    const result = read(query, vars);
    expect(result).toMatchObject({ unknown: false, branches: expect.arrayContaining([branch]) });
    expect(result.branches.some((b) => PROTECTED_RE.test(b))).toBe(PROTECTED_RE.test(branch));
  });
});

describe("graphqlBranchWrites, targets known only at run time", () => {
  it.each([
    ["a base read from a file", MERGE_BY_VAR, "-F base=@f"],
    ["a base set at run time", MERGE_BY_VAR, '-f base="$B"'],
    ["a base under a run-time key", MERGE_BY_VAR, '-f "$K"=main'],
    ["a base from a command substitution", MERGE_BY_VAR, "-f base=`cat b`"],
    ["a commit by id", commitOn('{id:"R"}'), ""],
    ["a commit by an id that spells a branch", commitOn('{id:"REF_main"}'), ""],
    ["a commit by id beside a feature branchName", commitOn('{id:"R",branchName:"feat/x"}'), ""],
    ["a commit by id while a comment names branchName", `# branchName: feat/x\n${commitOn('{id:"R"}')}`, ""],
    ["a commit by id while the headline says branchName", commitOn('{id:"R"}', 'message:{headline:"set branchName"}'), ""],
    ["a commit by id with commas and a comment before the colon", commitOn('{id , # c\n : "R"}'), ""],
    ["a commit by id in a JSON variables object", `{"query":${JSON.stringify(commitOn("$b"))},"variables":{"b":{"id":"R"}}}`, ""],
    ["a commit by id in a nested -F field", commitOn("$b"), "-F 'b[id]=R' -F 'b[branchName]=feat/x'"],
    ["a commit with no branch key at all", commitOn("$b"), "-f note=branchName"],
    ["a commit by id two levels deep", BY_INPUT, "-F 'i[branch][id]=REF_main'"],
    ["a deep id beside an aliased branchName selection", BY_INPUT.replace("commit{oid}", "branchName:commit{oid}"), "-F 'i[branch][id]=REF_main'"],
    ["a deep id while a comment names branchName", `# branchName:\n${BY_INPUT}`, "-F 'i[branch][id]=REF_main'"],
    ["a deep id beside a branchName field", BY_INPUT, "-F 'i[branch][id]=REF_main' -f branchName=feat/x"],
    ["a deep id in an array element", BY_INPUT, "-F 'i[branch][][id]=REF_main' -f 'i[branch][branchName]=feat/x'"],
    ["createLinkedBranch with no name", LINKED(""), ""],
    ["a base gh fills from {branch}", MERGE_BY_VAR, "-F 'base={branch}'"],
    ["a base with :branch inside a word", MERGE_BY_VAR, "-F base=m:branch"],
    ["a base with :branch before a dot", MERGE_BY_VAR, "-F base=:branch-1.0"],
    ["a base with {branch} after a prefix", MERGE_BY_VAR, "-F 'base=feature-{branch}'"],
    ["a base from {repo}", MERGE_BY_VAR, "-F 'base={repo}'"],
    ["a nested branchName gh fills", BY_INPUT, "-F 'i[branch][repositoryNameWithOwner]=o/r' -F 'i[branch][branchName]={branch}'"],
    ["an updateRefs name gh fills", `mutation($name:String!)${updateRefs("$name").slice("mutation".length)}`, "-F 'name=refs/heads/{branch}'"],
    ["a query string {branch}", merge('"{branch}"'), ""],
    ["a query string :branch", merge('":branch"'), ""],
    ["a query string refs/heads/{branch}", createRef('"refs/heads/{branch}"'), ""],
    ["a fill between unquoted halves of a value", merge("{branch}main{branch}"), ""],
    ["a fill before the first quote", 'mutation{mergeBranch(input:{base:{branch},repositoryId:"r",head:"feat/x"}){mergeCommit{oid}}}', ""],
    ["a fill after the last quote", merge("x:owner"), ""],
    ["fills in a query with no quotes", "mutation{createRef(input:{repositoryId:{repo},name:{owner},oid:{branch}}){ref{id}}}", ""],
    ["a key a command substitution extends past query", FEATURE_MERGE, '-f "query$(printf x)=main"'],
    ["a key a backquote substitution extends past query", FEATURE_MERGE, '-f "query`printf x`=main"'],
    ["a key a variable extends past query", FEATURE_MERGE, '-f "query${X}=main"'],
    ["a branchName key a substitution right before its = may change", BY_INPUT, "-F 'i[branch][branchName]'\"$(printf x)\"=feat/x"],
    ["a value a glob may expand", MERGE_BY_VAR, "-f base=mai?"],
    ["a key a glob may expand into a deep id", BY_INPUT, "-F i?branch??id?=REF_main -f 'i[branch][branchName]=feat/x'"],
    ["a value a brace list expands", MERGE_BY_VAR, "-f base=m{x,a}in"],
    ["an unquoted nested key, which globs", BY_INPUT, "-F 'i[branch][repositoryNameWithOwner]=o/r' -F i[branch][branchName]=feat/x"],
    ["a glob in a partly quoted value", MERGE_BY_VAR, '-f base="mai"?'],
    ["a feature merge with a text escaped past the cap", `${FEATURE_MERGE} # ${DEEP}`, ""],
  ])("reads %s as unknown", (_what, query, vars) => {
    expect(read(query, vars).unknown).toBe(true);
  });
});

describe("graphqlBranchWrites, texts with no branch mutation", () => {
  it.each([
    ["a viewer read", "{viewer{login}}", false],
    ["a mergeable read", 'query{repository(owner:"o",name:"r"){pullRequest(number:1){mergeable}}}', false],
    ["a field named mergeBranchX", "query{mergeBranchX}", false],
    ["a branch fill, which may hold any GraphQL text", "{viewer{login}}{branch}", true],
    ["an owner fill that completes a name", 'mutation{update:repo(input:{refId:"R",oid:"x"}){clientMutationId}}', true],
    ["an owner fill as the whole mutation name", `mutation{ {owner}${merge('"main"').slice("mutation{mergeBranch".length)}`, true],
    ["a repo fill behind an alias", `mutation{ a: {repo}${merge('"main"').slice("mutation{mergeBranch".length)}`, true],
    ["owner and repo fills joined into one name", `mutation{ {owner}{repo}${merge('"main"').slice("mutation{mergeBranch".length)}`, true],
    ["a colon-form owner as the name", `mutation{ :owner${merge('"main"').slice("mutation{mergeBranch".length)}`, true],
    ["an owner fill spliced in as the operation", `{owner}{ {repo}${merge('"main"').slice("mutation{mergeBranch".length)}`, true],
    ["a read naming a quoted owner and repo, as any fill may rewrite the query", 'query{repository(owner:"{owner}",name:"{repo}"){id}}', true],
    ["a read escaped past the cap", `{viewer{login}} # ${DEEP}`, true],
  ])("reads %s", (_what, query, unknown) => {
    expect(read(query, unknown ? "" : '-f x="$X"')).toEqual({ mutations: [], branches: [], unknown });
  });

  it("pins gh 2.102's placeholder pattern", () => {
    expect(GH_PLACEHOLDER_RE.source).toBe(String.raw`:(?:owner|repo|branch)\b|\{[a-z]+\}`);
  });
});

describe("decodeGraphqlEscapes", () => {
  it.each([
    [`${BS}u006dain`, "main"],
    [`${BS}u{6d}ain`, "main"],
    [`refs${BS}/heads${BS}/main`, "refs/heads/main"],
    [`${BS}"main${BS}"`, '"main"'],
    [`${BS}${BS}u006dain`, "main"],
    [`a${BS}nb`, "a\nb"],
    [`${BS}u{110000}`, `${BS}u{110000}`],
  ])("decodes %s", (text, decoded) => {
    expect(decodeGraphqlEscapes(text)).toEqual({ text: decoded, complete: true });
  });

  it("stops after the two layers GitHub decodes and says escapes are left", () => {
    expect(decodeGraphqlEscapes(`${BS}u{5c}u{5c}u006dain`)).toEqual({ text: `${BS}u006dain`, complete: false });
  });
});

describe("graphqlBranchWrites cost on crafted texts", () => {
  /** Past this a hook timeout would let the command through; a linear reading of 64 KB takes milliseconds. */
  const BUDGET_MS = 500;
  const KB = 1024;

  it.each([
    ["a chain of escapes, each pass peeling one", merge(`"${BS}u{5c}${"u{5c}".repeat((32 * KB) / 5)}u006dain${`${BS}u{110000}`.repeat((32 * KB) / 10)}"`)],
    ["commented id keys", `${commitOn("$b")}\n${"#id\n".repeat(16 * KB)}`],
  ])("reads 64 KB of %s as unknown within budget", (_what, text) => {
    const start = performance.now();
    expect(graphqlBranchWrites([text], []).unknown).toBe(true);
    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
  });
});
