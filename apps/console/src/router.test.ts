import { describe, expect, it } from "vitest";
import { VIEW_KEYS, href, parseRoute } from "./router.js";

describe("hash routes", () => {
  it.each(VIEW_KEYS)("round-trips the %s view", (view) => {
    expect(parseRoute(href({ view }))).toEqual({ view });
  });

  it("opens the status view for an empty or unknown hash", () => {
    expect(parseRoute("")).toEqual({ view: "status" });
    expect(parseRoute("#/nowhere")).toEqual({ view: "status" });
  });

  it("ignores a query string and deeper segments, which later views will own", () => {
    expect(parseRoute("#/sessions/abc?tab=replay")).toEqual({ view: "sessions" });
  });
});
