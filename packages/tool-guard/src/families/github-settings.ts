import type { SimpleCommand } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";
import { classified } from "../spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "../types.js";
import { apiSettingsWrite } from "./api-rulesets.js";
import type { SettingsWrite } from "./api-rulesets.js";
import { graphqlQueries, isGitHubGraphql } from "./curl-graphql.js";
import { ghApiRequest, isGraphqlEndpoint } from "./gh-api.js";
import { ghCommandLine } from "./gh-words.js";
import { graphqlBranchWrites, RULESET_MUTATIONS } from "./graphql-branch-writes.js";
import { httpRequest } from "./http-request.js";
import type { HttpRequest } from "./http-request.js";
import { set } from "./options.js";

/** Never the owner, repo or branch: the hard stop is the same whichever one it names. */
const subject = (write: SettingsWrite) => ({ pattern: `github:${write.route}`, scope: write.scope });

/** A ruleset mutation names its ruleset by an opaque id or its reach by globs, so the text never shows the scope. */
const GRAPHQL_WRITE: SettingsWrite = { route: "rulesets", scope: "unknown" };

const namesRulesetMutation = (texts: string[], fields: WordToken[] = []) =>
  graphqlBranchWrites(texts, fields).mutations.some((m) => RULESET_MUTATIONS.has(m));

const literalUrl = (value: string): WordToken =>
  ({ type: "word", value, typed: value, dynamic: false, quoted: true, spliced: false, computed: false, refs: [], subs: [], cuts: [] });

/**
 * gh resolves a relative endpoint against the API root, and GHES serves GraphQL under `api/`, so the endpoint reaches
 * GraphQL whenever the same path would for curl: `graphql.json`, `graphql;x` and `%67raphql` included.
 */
function ghReachesGraphql(endpoint: string): boolean {
  if (isGraphqlEndpoint(endpoint)) return true;
  const path = endpoint.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, "").replace(/^\/*(?:api\/)?/i, "");
  return isGitHubGraphql(literalUrl(`https://api.github.com/${path}`));
}

/**
 * Each `query=` field's text as written. An expansion inside it only adds text, so a mutation name written around it
 * still reaches GitHub, and gh's placeholder fills leave the name alone. A query read from a file or under a run-time
 * key is not read here; TP-2733 d owns that reading.
 */
function queryTexts(fields: WordToken[]): string[] {
  return fields.flatMap((f) => {
    const eq = f.value.indexOf("=");
    return eq >= 0 && f.value.slice(0, eq) === "query" ? [f.value.slice(eq + 1)] : [];
  });
}

/** A gh endpoint known only at run time is not read here; TP-2707 d owns that reading. */
function ghSettings(cmd: SimpleCommand): ClassifiedAction[] {
  const line = ghCommandLine(cmd.args);
  if (line.hidden || line.path.join(" ") !== "api") return [];
  const { endpoint, method, fields } = ghApiRequest(line.leaf);
  if (endpoint === null) return [];
  if (ghReachesGraphql(endpoint)) {
    return namesRulesetMutation(queryTexts(fields), fields) ? [classified("bash.config.gh-api-graphql-ruleset", subject(GRAPHQL_WRITE))] : [];
  }
  const write = apiSettingsWrite(endpoint, method);
  return write ? [classified("bash.config.gh-api-ruleset", subject(write))] : [];
}

/**
 * A body read from a file, known only at run time, or sent as httpie items, which are never read, may carry any
 * mutation, so on GitHub's GraphQL endpoint it is an unknown ruleset write.
 */
function curlGraphqlWrite(request: HttpRequest): boolean {
  if (!request.urls.some(isGitHubGraphql)) return false;
  const queries = graphqlQueries(request.bodies);
  return queries === null || namesRulesetMutation(queries);
}

/** A run-time URL is already denied as `bash.merge.curl-api` when it may reach the GitHub API. */
function httpSettings(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  const request = httpRequest(cmd, ctx);
  if (!request) return [];
  const writes = request.urls.filter((u) => !u.dynamic).flatMap((u) => apiSettingsWrite(u.value, request.method) ?? []);
  if (writes.length > 0) return writes.slice(0, 1).map((write) => classified("bash.config.curl-api-ruleset", subject(write)));
  return curlGraphqlWrite(request) ? [classified("bash.config.curl-graphql-ruleset", subject(GRAPHQL_WRITE))] : [];
}

/**
 * GitHub ruleset and branch-protection writes are authority configuration, the `ruleset-write` hard stop, not
 * merges: the merge family's rows would let automation through on a reviewer's MERGE verdict.
 */
export const githubSettings: Family = {
  names: set("gh", "curl", "wget", "http", "https"),
  bash: (cmd, ctx) => (cmd.name === "gh" ? ghSettings(cmd) : httpSettings(cmd, ctx)),
};
