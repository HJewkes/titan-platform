import type { SimpleCommand } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";
import { classified } from "../spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "../types.js";
import { apiSettingsWrite } from "./api-rulesets.js";
import type { SettingsWrite } from "./api-rulesets.js";
import { graphqlQueries, isGitHubGraphql } from "./curl-graphql.js";
import { ghApiRequest, isGraphqlEndpoint } from "./gh-api.js";
import type { GhApiRequest } from "./gh-api.js";
import { ghCommandLine } from "./gh-words.js";
import { graphqlBranchWrites, RULESET_MUTATIONS } from "./graphql-branch-writes.js";
import { httpRequest } from "./http-request.js";
import type { HttpRequest } from "./http-request.js";
import { set } from "./options.js";

/** Never the owner, repo or branch: the hard stop is the same whichever one it names. */
const subject = (write: SettingsWrite) => ({ pattern: `github:${write.route}`, scope: write.scope });

/** A ruleset mutation names its ruleset by an opaque id or its reach by globs, so the text never shows the scope. */
const GRAPHQL_WRITE: SettingsWrite = { route: "rulesets", scope: "unknown" };

/**
 * The one decision for every route into GitHub GraphQL. `texts` are the query texts the request sends, or null when
 * the guard cannot read them. A request passes only when its texts are read in full and name no ruleset mutation: an
 * unread text, or a reading `graphqlBranchWrites` calls unknown with no mutation named (a gh fill that may be the
 * whole name, an escape past the two layers GitHub decodes), is an unknown ruleset write.
 */
function rulesetWrite(texts: string[] | null, fields: WordToken[] = []): boolean {
  if (texts === null) return true;
  const reading = graphqlBranchWrites(texts, fields);
  return (reading.unknown && reading.mutations.length === 0) || reading.mutations.some((m) => RULESET_MUTATIONS.has(m));
}

const INPUT_RE = /^--input(?:=|$)/;

/**
 * The `query=` texts a gh GraphQL call sends, as written. Null when gh reads a query from a file (`query=@f`,
 * `--input`) or the shell decides or rewrites it at run time (`queryUnknown`). A gh fill in a read text may become any
 * text, a whole mutation name included; `rulesetWrite` reads that from `graphqlBranchWrites`.
 */
function ghQueryTexts(leaf: WordToken[], request: GhApiRequest): string[] | null {
  const texts = request.fields.flatMap((f) => {
    const eq = f.value.indexOf("=");
    return eq >= 0 && f.value.slice(0, eq) === "query" ? [f.value.slice(eq + 1)] : [];
  });
  const unread = request.queryUnknown || texts.some((t) => t.startsWith("@")) || leaf.some((w) => INPUT_RE.test(w.value));
  return unread ? null : texts;
}

/** A gh endpoint known only at run time is not read here; TP-2707 d owns that reading. */
function ghSettings(cmd: SimpleCommand): ClassifiedAction[] {
  const line = ghCommandLine(cmd.args);
  if (line.hidden || line.path.join(" ") !== "api") return [];
  const request = ghApiRequest(line.leaf);
  if (request.endpoint === null) return [];
  if (isGraphqlEndpoint(request.endpoint)) {
    const write = rulesetWrite(ghQueryTexts(line.leaf, request), request.fields);
    return write ? [classified("bash.config.gh-api-graphql-ruleset", subject(GRAPHQL_WRITE))] : [];
  }
  const write = apiSettingsWrite(request.endpoint, request.method);
  return write ? [classified("bash.config.gh-api-ruleset", subject(write))] : [];
}

/** `graphqlQueries` is null for a body read from a file or known only at run time, and for httpie items, never read. */
const curlGraphqlWrite = (request: HttpRequest) => request.urls.some(isGitHubGraphql) && rulesetWrite(graphqlQueries(request.bodies));

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
