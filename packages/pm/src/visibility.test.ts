import { describe, expect, it } from "vitest";
import { agentAccess, isAgentVisible } from "./visibility.js";
import { TRANSITIONAL_AGENT_VISIBLE } from "./visibility-transitional.js";

const LISTED = TRANSITIONAL_AGENT_VISIBLE.initiatives[0];

describe("isAgentVisible", () => {
  it("serves an initiative whose brief declares agent-visible", () => {
    expect(isAgentVisible({ slug: "alpha", brief: { title: "Alpha", visibility: "agent-visible" } })).toBe(true);
  });

  it("withholds an initiative whose brief declares owner-only", () => {
    expect(isAgentVisible({ slug: "private-notes", brief: { visibility: "owner-only" } })).toBe(false);
  });

  it("withholds a new initiative whose brief has no visibility key", () => {
    expect(isAgentVisible({ slug: "private-notes", brief: { title: "Private notes" } })).toBe(false);
  });

  it("withholds an initiative whose brief could not be parsed", () => {
    expect(isAgentVisible({ slug: "alpha", brief: null })).toBe(false);
    expect(isAgentVisible({ slug: LISTED, brief: null })).toBe(false);
  });

  it("withholds a visibility value outside the closed set", () => {
    expect(isAgentVisible({ slug: "alpha", brief: { visibility: "public" } })).toBe(false);
    expect(isAgentVisible({ slug: LISTED, brief: { visibility: "agent" } })).toBe(false);
  });

  it("keeps a transitional code initiative visible until its brief declares visibility", () => {
    expect(isAgentVisible({ slug: LISTED, brief: { title: "Listed" } })).toBe(true);
  });

  it("lets an explicit owner-only brief override the transitional list", () => {
    expect(isAgentVisible({ slug: LISTED, brief: { visibility: "owner-only" } })).toBe(false);
  });
});

const AGENT_VISIBLE = { visibility: "agent-visible" };

describe("agentAccess", () => {
  it.each([
    ["an agent-visible brief the charter lists human-only", "garden-plan", AGENT_VISIBLE, true, "withheld"],
    ["an agent-visible brief under an unreadable charter", "alpha", AGENT_VISIBLE, "unknown", "withheld"],
    ["a missing brief the charter does not list", "alpha", null, false, "withheld"],
    ["an owner-only brief the charter does not list", "private-notes", { visibility: "owner-only" }, false, "withheld"],
    ["a transitional initiative the charter lists human-only", LISTED, { title: "Listed" }, true, "withheld"],
    ["a transitional initiative the charter does not list", LISTED, { title: "Listed" }, false, "shown"],
    ["an agent-visible brief the charter does not list", "alpha", AGENT_VISIBLE, false, "shown"],
  ] as const)("reads %s as %s", (_scenario, slug, brief, humanOnly, expected) => {
    expect(agentAccess({ slug, brief, humanOnly })).toBe(expected);
  });
});
