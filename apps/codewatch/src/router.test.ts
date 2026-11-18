import { CONTRACT } from "@titan-design/code-read/query";
import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES_QUERY, SORT_KEYS, href, parseRoute, type Route } from "./router.js";

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

  it("keeps the raw tail when a node or finding id has a malformed escape", () => {
    expect(parseRoute("#/node/%")).toEqual({ page: "node", id: "%" });
    expect(parseRoute("#/finding/50%")).toEqual({ page: "finding", id: "50%" });
  });
});

describe("DEFAULT_PRIORITIES_QUERY", () => {
  it("rejects writes to the query and its filters so the shared default stays intact", () => {
    expect(Object.isFrozen(DEFAULT_PRIORITIES_QUERY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PRIORITIES_QUERY.filters)).toBe(true);
    expect(() => {
      (DEFAULT_PRIORITIES_QUERY as { offset: number }).offset = 50;
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_PRIORITIES_QUERY.filters as { severity?: string[] }).severity = ["error"];
    }).toThrow(TypeError);
    expect(DEFAULT_PRIORITIES_QUERY).toEqual({ filters: {}, sort: "severity", offset: 0 });
  });
});
