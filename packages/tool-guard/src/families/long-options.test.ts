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
  ])("%s: %s reads as %s", (_name, flag, resolved) => {
    expect(wget(flag)).toBe(resolved);
  });
});

describe("the option tables match the binaries they were read from", () => {
  it("holds every curl 8.18.0 long option and no --expand- prefix form", () => {
    expect(CURL_LONG).toHaveLength(268);
    expect(CURL_LONG).toEqual(expect.arrayContaining(["config", "request-target", "url-query", "data-urlencode"]));
    expect(CURL_LONG.filter((n) => n.startsWith("expand-"))).toEqual([]);
  });

  it("holds every wget 1.25.0 long option, its body and method options among them", () => {
    expect(WGET_LONG).toHaveLength(152);
    expect(WGET_LONG).toEqual(expect.arrayContaining(["method", "post-data", "post-file", "body-data", "body-file"]));
  });
});
