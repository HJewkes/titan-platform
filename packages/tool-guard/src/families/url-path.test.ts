import { describe, expect, it } from "vitest";
import { curlSquashed, hasDotSegment } from "./url-path.js";

const API = "https://api.github.com";

describe("curl resolves dot segments before it sends the path", () => {
  it.each([
    ["a parent segment", `${API}/repos/o/r/x/../pulls/1/merge`, `${API}/repos/o/r/pulls/1/merge`],
    ["a lower-case %2e parent", `${API}/repos/o/r/x/%2e%2e/pulls/1/merge`, `${API}/repos/o/r/pulls/1/merge`],
    ["a mixed .%2E parent", `${API}/repos/o/r/x/.%2E/pulls/1/merge`, `${API}/repos/o/r/pulls/1/merge`],
    ["a mixed %2e. parent", `${API}/repos/o/r/x/%2e./pulls/1/merge`, `${API}/repos/o/r/pulls/1/merge`],
    ["a single %2e segment", `${API}/repos/o/r/%2E/merges`, `${API}/repos/o/r/merges`],
    ["a final dot", `${API}/repos/o/r/pulls/1/merge/.`, `${API}/repos/o/r/pulls/1/merge/`],
    ["a final parent", `${API}/repos/o/r/pulls/1/x/..`, `${API}/repos/o/r/pulls/1/`],
    ["no climbing above root", `${API}/a/b/../../../../repos/o/r/merges`, `${API}/repos/o/r/merges`],
    ["a parent alone", `${API}/..`, `${API}/`],
    ["a parent that pops an empty segment", `${API}/repos/o/r/x//../pulls/1/merge`, `${API}/repos/o/r/x/pulls/1/merge`],
    ["three dots kept", `${API}/x/.../y`, `${API}/x/.../y`],
    ["an encoded slash kept", `${API}/x/..%2f/y`, `${API}/x/..%2f/y`],
    ["a semicolon parameter kept", `${API}/x/..;/y`, `${API}/x/..;/y`],
    ["the query untouched", `${API}/repos/o/r/pulls/1/merge/./?q=/../x`, `${API}/repos/o/r/pulls/1/merge/?q=/../x`],
    ["the fragment untouched", `${API}/repos/o/r/x/../y#f/..`, `${API}/repos/o/r/y#f/..`],
    ["a scheme-less host", "127.0.0.1:9/x/../y", "127.0.0.1:9/y"],
    ["one slash keeps the host curl dials", "http:/127.0.0.1:9/../localhost:3000/x", "http:/127.0.0.1:9/localhost:3000/x"],
    ["three slashes keep the host curl dials", "http:///127.0.0.1:9/../localhost:3000/x", "http:///127.0.0.1:9/localhost:3000/x"],
    ["four slashes, which curl rejects, as written", "http:////127.0.0.1:9/a/../b", "http:////127.0.0.1:9/a/../b"],
    ["no path", API, API],
    ["a query with no path", "127.0.0.1:9?q=/../x", "127.0.0.1:9?q=/../x"],
  ])("%s", (_name, url, sent) => {
    expect(curlSquashed(url)).toBe(sent);
  });
});

describe("hasDotSegment reads the path before any query or fragment", () => {
  it.each([
    ["a raw parent", "repos/o/r/x/../y", true],
    ["a %2E%2e parent", "x/%2E%2e/y", true],
    ["a .%2e parent", "x/.%2e/y", true],
    ["a dot once %2f decodes", "x/..%2fy", true],
    ["a raw dot", "x/./y", true],
    ["three dots", "x/.../y", false],
    ["a semicolon parameter", "x/..;/y", false],
    ["dots in the query", "x/y?q=/../z", false],
    ["dots in the fragment", "x/y#/..", false],
  ])("%s", (_name, path, dotted) => {
    expect(hasDotSegment(path)).toBe(dotted);
  });
});
