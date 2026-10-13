import { describe, expect, it } from "vitest";
import { expandCurlGlob } from "./curl-glob.js";

const API = "https://api.github.com/repos/o/r";

describe("expandCurlGlob expands what curl would request", () => {
  it.each([
    ["a set", `${API}/pulls/{1,2}/merge`, [`${API}/pulls/1/merge`, `${API}/pulls/2/merge`]],
    ["a set with an empty item", `${API}/pull{s,}/1`, [`${API}/pulls/1`, `${API}/pull/1`]],
    ["a set with one item", `${API}/pulls/1/{merge}`, [`${API}/pulls/1/merge`]],
    ["a set spanning path segments", `${API}/{pulls/1/merge,x}`, [`${API}/pulls/1/merge`, `${API}/x`]],
    ["a number range", "h/[1-3]", ["h/1", "h/2", "h/3"]],
    ["a zero-padded range", "h/[01-03]", ["h/01", "h/02", "h/03"]],
    ["a stepped range", "h/[1-9:4]", ["h/1", "h/5", "h/9"]],
    ["a letter range", "h/[a-c]", ["h/a", "h/b", "h/c"]],
    ["a one-letter range", `${API}/pulls/1/merg[e-e]`, [`${API}/pulls/1/merge`]],
    ["a set then a range, rightmost fastest", "h/{a,b}[1-2]", ["h/a1", "h/a2", "h/b1", "h/b2"]],
    ["escaped braces as literal text", "h/\\{x\\}", ["h/{x}"]],
    ["an escaped comma inside a set", "h/{a\\,b,c}", ["h/a,b", "h/c"]],
  ])("%s", (_name, text, urls) => {
    expect(expandCurlGlob(text)).toEqual(urls);
  });
});

describe("expandCurlGlob keeps text curl does not glob", () => {
  it.each([
    ["plain URL", `${API}/pulls/1/merge`],
    ["an IPv6 loopback literal", "http://[::1]:4000/"],
    ["an IPv6 literal with a zone id", "http://[fe80::1%25en0]/"],
    ["empty brackets", "h/x[]"],
  ])("%s", (_name, text) => {
    expect(expandCurlGlob(text)).toEqual([text]);
  });
});

describe("expandCurlGlob returns null where curl refuses the glob or it is too large", () => {
  it.each([
    ["an unclosed set", "h/{a,b"],
    ["an empty set", "h/{}"],
    ["a nested set", "h/{a,{b,c}}"],
    ["an unmatched close brace", "h/x}"],
    ["a range without a dash", "h/x[0]"],
    ["a range with one colon is not IPv6", "h/x[1:2]"],
    ["a letter-to-digit range", "h/x[a-1]"],
    ["a descending range", "h/x[3-1]"],
    ["a step wider than the range", "h/x[1-3:5]"],
    ["a zero step", "h/x[1-3:0]"],
    ["an unclosed range", "h/x[1-3"],
    ["a product over the cap", "h/[1-9][1-9]"],
    ["a range too long to list", "h/[0-99999999999]"],
  ])("%s", (_name, text) => {
    expect(expandCurlGlob(text)).toBeNull();
  });

  it("honours a caller's cap", () => {
    expect(expandCurlGlob("h/{a,b,c}", 2)).toBeNull();
    expect(expandCurlGlob("h/{a,b}", 2)).toHaveLength(2);
  });
});
