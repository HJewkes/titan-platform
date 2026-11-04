import { describe, expect, it } from "vitest";
import { claimFacts } from "./claim-facts.js";

describe("claimFacts", () => {
  it("reads a daily digest's items with every field the gather wrote", () => {
    const digest = JSON.stringify({ since: "2031-01-02T00:00:00Z", items: [{ id: "pr/acme/desk#7/merged", kind: "pr", change: "merged", repo: "acme/desk" }] });

    expect(claimFacts(digest)).toEqual([{ id: "pr/acme/desk#7/merged", kind: "pr", change: "merged", repo: "acme/desk" }]);
  });

  it("reads a facts pack's rows when the text is no digest", () => {
    const pack = "| Id | Claim |\n|---|---|\n| task/QA-901/opened | task opened · demo |\n";

    expect(claimFacts(pack)).toEqual([{ id: "task/QA-901/opened", text: "task opened · demo" }]);
  });

  it("gives no facts for text that holds neither", () => {
    expect(claimFacts("# Notes\n\nNothing gathered.\n")).toBeUndefined();
  });
});
