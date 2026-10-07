import { CONTRACT } from "@titan-design/code-read/query";
import { describe, expect, it } from "vitest";
import { SORT_KEYS, href, parseRoute, type Route } from "./router.js";

describe("hash routes", () => {
  it.each<Route>([
    { page: "overview" },
    { page: "compare" },
    { page: "node", id: "" },
    { page: "node", id: "packages/code-read/src/query/model.ts#buildReadModel" },
    { page: "finding", id: "no-fs|src/io.ts|node:fs" },
    { page: "priorities", query: { filters: { rule: ["a", "b"], severity: ["error"] }, sort: "excess", offset: 25 } },
  ])("round-trips %j", (route) => {
    expect(parseRoute(href(route))).toEqual(route);
  });

  it("falls back to the overview for an unknown page and to defaults for bad paging", () => {
    expect(parseRoute("#/nowhere")).toEqual({ page: "overview" });
    expect(parseRoute("#/priorities?sort=bogus&offset=-3")).toEqual({ page: "priorities", query: { filters: {}, sort: "severity", offset: 0 } });
  });

  it.each(SORT_KEYS)("parses the sort %s, which findings.list accepts", (sort) => {
    expect(CONTRACT["findings.list"].args.safeParse({ sort }).success).toBe(true);
    expect(parseRoute(`#/priorities?sort=${sort}`)).toMatchObject({ query: { sort } });
  });
});
