import { describe, expect, it } from "vitest";
import { extractCommands } from "../shell/commands.js";
import { GH_API_VALUES, ghApiRequest, isGraphqlEndpoint } from "./gh-api.js";
import type { GhApiRequest } from "./gh-api.js";

/** The words after `gh api` on the line's last command, as the merge family hands them over. */
function request(line: string): GhApiRequest {
  const gh = extractCommands(line, { home: "/home/you" }).at(-1);
  if (gh?.name !== "gh" || gh.args[0]?.value !== "api") throw new Error(`not a gh api line: ${line}`);
  return ghApiRequest(gh.args.slice(1));
}

describe("GH_API_VALUES", () => {
  it("names gh 2.102's value-taking api flags and none of its booleans", () => {
    expect(GH_API_VALUES.has("--hostname")).toBe(true);
    expect(["--paginate", "--slurp", "--silent", "--verbose", "-i", "--include"].some((f) => GH_API_VALUES.has(f))).toBe(false);
  });
});

describe("ghApiRequest endpoint", () => {
  it.each([
    ["gh api $X"],
    ['gh api "$X"'],
    ["gh api -X PUT repos/$R/pulls/1/merge"],
    ['gh api "repos/$R/pulls/$N"'],
    ["gh api $F repos/o/r/pulls/1/merge"],
    ['gh api "$F" repos/o/r/pulls/1/merge'],
    ["gh api -H $H repos/o/r/pulls/1/merge"],
    ["gh api -X $M repos/o/r/pulls/1/merge"],
    ["gh api repos/$(cat r)/pulls/1/merge"],
    ["declare -l E=repos/o/r/pulls/1/MERGE; gh api -X PUT $E"],
    ["E='repos/o/r/pulls/1/merge -X PUT'; gh api $E"],
    ["E=''; gh api -X $E repos/o/r/pulls/1/merge"],
    ['gh api -H "$A"$B repos/o/r/pulls/1/merge'],
  ])("%s has no known endpoint", (line) => {
    expect(request(line).endpoint).toBeNull();
  });

  it.each([
    ["gh api -X PUT repos/o/r/pulls/1/merge", "repos/o/r/pulls/1/merge"],
    ['gh api -H "$H" repos/o/r/pulls/1/merge', "repos/o/r/pulls/1/merge"],
    ['gh api --method="$M" repos/o/r/pulls/1/merge', "repos/o/r/pulls/1/merge"],
    ['gh api -X "$M" repos/o/r/pulls/1/merge', "repos/o/r/pulls/1/merge"],
    ["gh api repos/o/r/pulls/1/merge $F", "repos/o/r/pulls/1/merge"],
    ["gh api --paginate -- -x", "-x"],
    ["R=o/r; gh api repos/$R/pulls/1", "repos/o/r/pulls/1"],
    ["E=repos/o/r/pulls/1; gh api $E", "repos/o/r/pulls/1"],
    ["E='a b'; gh api \"$E\"", "a b"],
  ])("%s reads endpoint %s", (line, endpoint) => {
    expect(request(line).endpoint).toBe(endpoint);
  });

  it("marks an endpoint word that word-splits, and not the same word quoted", () => {
    expect(request("gh api repos/o/r/pulls/$N").endpointSplits).toBe(true);
    expect(request('gh api "repos/o/r/pulls/$N"').endpointSplits).toBe(false);
    expect(request('gh api "repos/o/r/pulls/"$N').endpointSplits).toBe(true);
    expect(request("E='repos/o/r/pulls/1/merge -X PUT'; gh api $E").endpointSplits).toBe(true);
    expect(request("E=repos/o/r/pulls/1; gh api $E").endpointSplits).toBe(false);
  });
});

describe("ghApiRequest method", () => {
  it.each([
    ["gh api -X $M repos/o/r/pulls/1/merge"],
    ['gh api --method="$M" repos/o/r/pulls/1/merge'],
    ["gh api -X$M repos/o/r/pulls/1/merge"],
    ["gh api repos/o/r/pulls/1/merge $F"],
    ['gh api repos/o/r/pulls/1/merge "$F"'],
    ['gh api "$F" repos/o/r/pulls/1/merge'],
    ['gh api "--$F" x repos/o/r/pulls/1/merge'],
    ["gh api repos/o/r/pulls/1/merge -H $H"],
    ["gh api -X $(echo PUT) repos/o/r/pulls/1/merge"],
    ["declare -u M=put; gh api -X $M repos/o/r/pulls/1/merge"],
    ["E='repos/o/r/pulls/1/merge -X PUT'; gh api $E"],
    ["E=''; gh api -X $E repos/o/r/pulls/1/merge"],
    ["H='a -X PUT'; gh api repos/o/r/pulls/1/merge -H $H"],
    ['gh api repos/o/r/pulls/1/merge "${F:--XPUT}"'],
  ])("%s has no known method", (line) => {
    expect(request(line).method).toBeNull();
  });

  it.each([
    ['gh api "repos/$R/pulls/$N"', "GET"],
    ["gh api repos/o/r/pulls/$N", "GET"],
    ["gh api repos/o/r/pulls/1 --paginate --jq .title", "GET"],
    ["gh api -f x=1 repos/o/r/issues", "POST"],
    ["gh api --input f repos/o/r/issues", "POST"],
    ['gh api "$EP" -f x=1', "POST"],
    ['gh api -X POST repos/o/r/issues/1/comments -f body="$B"', "POST"],
    ["gh api -XPUT repos/o/r/pulls/1/merge", "PUT"],
    ["gh api repos/o/r/pulls/1/merge --method=put", "PUT"],
    ['gh api -X GET -H "$H" "$X"', "GET"],
    ["gh api -X GET -X PUT repos/o/r/pulls/1/merge", "PUT"],
    ["gh api --method PUT -X GET repos/o/r/pulls/1/merge", "GET"],
    ["H='a b'; gh api repos/o/r/pulls/1/merge -H \"$H\"", "GET"],
  ])("%s reads method %s", (line, method) => {
    expect(request(line).method).toBe(method);
  });
});

describe("ghApiRequest graphql query", () => {
  it.each([
    ['gh api graphql -f query="$Q"'],
    ["gh api graphql --raw-field=query=$Q"],
    ['gh api graphql -F "$KV"'],
    ['gh api "$EP" -f query="$Q"'],
    ['gh api graphql "$F"'],
    ['gh api /graphql -f query="$Q"'],
    ['gh api https://api.github.com/graphql -f query="$Q"'],
    ['gh api "graphql?x=1" -f query="$Q"'],
    ['gh api api/graphql -f query="$Q"'],
    ['gh api graphql -F "q$K"'],
    ["gh api graphql -f query='{ viewer { login } }' -F n=$N"],
    ["gh api graphql -f query='{ viewer { login } }' -H $H"],
  ])("%s carries an unknown query", (line) => {
    expect(request(line).queryUnknown).toBe(true);
  });

  it.each([
    ["gh api graphql -f query='{ viewer { login } }'"],
    ["gh api graphql -F query=@q.graphql"],
    ['gh api graphql -f query="{ viewer { login } }" -F owner="$O"'],
    ['gh api repos/o/r/issues -f query="$Q"'],
    ['gh api graphqlx -f query="$Q"'],
    ['gh api graphql -F query=@"$F"'],
    ['gh api graphql -F "x$K"'],
  ])("%s carries no unknown query", (line) => {
    expect(request(line).queryUnknown).toBe(false);
  });

  it.each(["graphql", "/graphql", "graphql/", "https://api.github.com/graphql", "https://ghe.example/api/graphql", "graphql?x=1", "GraphQL"])(
    "%s is the graphql endpoint",
    (endpoint) => {
      expect(isGraphqlEndpoint(endpoint)).toBe(true);
    },
  );

  it.each(["graphqlx", "repos/o/r/graphql", "https://api.github.com/repos/o/r", "x/graphql"])("%s is not the graphql endpoint", (endpoint) => {
    expect(isGraphqlEndpoint(endpoint)).toBe(false);
  });

  it("collects every field value", () => {
    const fields = request("gh api graphql -f query=q -F n=1 --raw-field=a=b").fields.map((f) => f.value);

    expect(fields).toEqual(["query=q", "n=1", "a=b"]);
  });
});
