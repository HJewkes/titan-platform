import { describe, expect, it } from "vitest";
import { AMBIGUOUS_LONG, CURL_LONG, WGET_LONG, resolveLong } from "./long-options.js";

const curl = resolveLong(CURL_LONG, true);
const wget = resolveLong(WGET_LONG, false);

describe("curl long options resolve as older curl matched them", () => {
  it.each([
    ["a case variant", "--Config", "--config"],
    ["an upper-case spelling", "--CONFIG", "--config"],
    ["a unique prefix", "--conf", "--config"],
    ["a case-variant prefix", "--Conf", "--config"],
    ["an exact name", "--json", "--json"],
    ["an exact name that prefixes others", "--data", "--data"],
    ["an exact name in another case that prefixes others", "--Request", "--request"],
    ["a prefix of the five --data options", "--dat", AMBIGUOUS_LONG],
    ["a prefix of --request and --request-target", "--req", AMBIGUOUS_LONG],
    ["a prefix of --url and --url-query", "--ur", AMBIGUOUS_LONG],
    ["a name curl does not have", "--nonsense", "--nonsense"],
    ["a dotted name --help omits", "--http1.0", "--http1.0"],
    ["a cut-off dotted name, a prefix of three", "--http1", AMBIGUOUS_LONG],
    ["a hidden alias", "--Krb4", "--krb4"],
    ["a bare double dash", "--", "--"],
  ])("%s: %s reads as %s", (_name, flag, resolved) => {
    expect(curl(flag)).toBe(resolved);
  });
});

describe("wget long options resolve as getopt_long matches them", () => {
  it.each([
    ["a unique prefix", "--meth", "--method"],
    ["a longer unique prefix", "--post-d", "--post-data"],
    ["an exact name", "--method", "--method"],
    ["an upper-case spelling, which wget rejects", "--METHOD", "--METHOD"],
    ["a prefix of --post-data and --post-file", "--post", AMBIGUOUS_LONG],
    ["a hidden flag that prefixes --hsts-file", "--hsts", "--hsts"],
    ["a hidden --no- form", "--no-hsts", "--no-hsts"],
  ])("%s: %s reads as %s", (_name, flag, resolved) => {
    expect(wget(flag)).toBe(resolved);
  });
});

describe("the option tables match the binaries they were read from", () => {
  it.each([
    ["curl", CURL_LONG, curl],
    ["wget", WGET_LONG, wget],
  ])("every %s name resolves to itself", (_tool, table, resolve) => {
    expect(table.names.filter((n) => resolve(`--${n}`) !== `--${n}`)).toEqual([]);
  });

  it("holds every curl 8.18.0 long option, hidden aliases included, and no --expand- prefix form", () => {
    expect(CURL_LONG.names).toHaveLength(391);
    expect(CURL_LONG.names).toEqual(expect.arrayContaining(["config", "request-target", "url-query", "http0.9", "http1.1", "include", "keepalive", "sessionid"]));
    expect(CURL_LONG.names).not.toEqual(expect.arrayContaining(["http0"]));
    expect(CURL_LONG.names.filter((n) => n.startsWith("expand-"))).toEqual([]);
  });

  it("holds every wget 1.25.0 long option, hidden ones included", () => {
    expect(WGET_LONG.names).toHaveLength(240);
    expect(WGET_LONG.names).toEqual(expect.arrayContaining(["method", "post-data", "body-file", "hsts", "glob", "xattr", "no-clobber"]));
  });

  it.each([
    ["curl", CURL_LONG, ["--config", "--data", "--request", "--proxy1.0", "--krb4", "--url"], ["--include", "--http1.0", "--location"]],
    ["wget", WGET_LONG, ["--method", "--post-data", "--hsts-file", "--execute", "--no"], ["--hsts", "--quiet", "--no-hsts"]],
  ])("marks which %s options take a value", (_tool, table, valued, bare) => {
    expect(valued.filter((f) => !table.values.has(f))).toEqual([]);
    expect(bare.filter((f) => table.values.has(f))).toEqual([]);
  });
});
