import { describe, expect, it } from "vitest";
import { VIEW_KEYS, href, parseRoute, type Route } from "./router.js";

describe("hash routes", () => {
  it.each(VIEW_KEYS)("round-trips the %s view", (view) => {
    expect(parseRoute(href({ view }))).toEqual({ view });
  });

  it("opens the home view for an empty or unknown hash, and for a view that left the rail", () => {
    expect(parseRoute("")).toEqual({ view: "home" });
    expect(parseRoute("#/nowhere")).toEqual({ view: "home" });
    expect(parseRoute("#/stores")).toEqual({ view: "home" });
  });

  it("round-trips an initiative detail route, and a slug that needs encoding", () => {
    expect(parseRoute("#/initiatives/orbit-relay")).toEqual({ view: "initiatives", id: "orbit-relay" });
    expect(parseRoute(href({ view: "initiatives", id: "a b" }))).toEqual({ view: "initiatives", id: "a b" });
  });

  it.each<[string, Route]>([
    ["#/tasks/OR-12?tab=sessions", { view: "tasks", id: "OR-12", query: "tab=sessions" }],
    ["#/sessions/0b7e2c1a-5d4f-4e8b-9a61-3c2d1e0f9a8b?tab=conversation", { view: "sessions", id: "0b7e2c1a-5d4f-4e8b-9a61-3c2d1e0f9a8b", query: "tab=conversation" }],
    ["#/agents/relay-worker-3?since=2031-03-01", { view: "agents", id: "relay-worker-3", query: "since=2031-03-01" }],
    ["#/knowledge/note%3Aorbit-relay%2F2031-03-03-backoff-ceiling.md?tab=graph", { view: "knowledge", id: "note:orbit-relay/2031-03-03-backoff-ceiling.md", query: "tab=graph" }],
  ])("parses %s and writes it back unchanged", (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
    expect(href(route)).toBe(hash);
  });

  it("keeps the query string on a list route, as the board's ?task= deep link needs", () => {
    expect(parseRoute("#/tasks?task=OR-12")).toEqual({ view: "tasks", query: "task=OR-12" });
    expect(href({ view: "tasks", query: "task=OR-12" })).toBe("#/tasks?task=OR-12");
  });

  it("encodes a knowledge ref as one segment", () => {
    const encoded = href({ view: "knowledge", id: "source:orbit-relay/captures/station-7.md" });
    expect(encoded.split("?")[0]!.split("/")).toHaveLength(3);
  });

  it("reads a knowledge ref typed without encoding as the whole ref", () => {
    expect(parseRoute("#/knowledge/source:orbit-relay/captures/station-7.md")).toEqual({ view: "knowledge", id: "source:orbit-relay/captures/station-7.md" });
  });

  it("keeps the raw detail when it has a malformed escape", () => {
    expect(parseRoute("#/initiatives/50%")).toEqual({ view: "initiatives", id: "50%" });
    expect(parseRoute("#/knowledge/note:a/%E0%A4%A?tab=graph")).toEqual({ view: "knowledge", id: "note:a/%E0%A4%A", query: "tab=graph" });
  });
});
