import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.js";
import { formatReport } from "./report.js";
import { scan } from "./scan.js";
import { parseTerms } from "./terms.js";

const user = "planted" + "-name";
const plantedPath = ["", "Users", user, "src"].join("/");
const term = "zq-planted-" + "term";
const leakyLine = `cd ${plantedPath} && echo ${term}`;

const diff = [
  "diff --git a/docs/setup.md b/docs/setup.md",
  "--- a/docs/setup.md",
  "+++ b/docs/setup.md",
  "@@ -3,0 +4,1 @@",
  `+${leakyLine}`,
].join("\n");

describe("formatReport", () => {
  const result = scan([parseDiff(diff)], { terms: parseTerms(`# terms\n\n${term}`) });
  const report = formatReport(result.findings, { ...result, termsLoaded: true }).join("\n");

  it("gives file:line and the rule id for each finding", () => {
    expect(report).toContain("docs/setup.md:4 home-path");
    expect(report).toContain("docs/setup.md:4 private-term #3");
  });

  it("never echoes the planted path, the term or the matched line", () => {
    for (const secret of [user, plantedPath, term, leakyLine]) expect(report).not.toContain(secret);
  });

  it("summarises found and allowed counts per rule, skipped binaries and the term list", () => {
    expect(report).toContain("egress-scan: 2 findings (home-path 1, aw-data-path 0, private-term 1, credential-token 0)");
    expect(report).toContain("allowed: home-path 0, aw-data-path 0");
    expect(report).toContain("binary files skipped: 0");
    expect(report).toContain("private term list: loaded");
  });

  it("says when only the generic rules ran", () => {
    const lines = formatReport([], { ...result, termsLoaded: false });
    expect(lines).toContain("egress-scan: 0 findings (home-path 0, aw-data-path 0, private-term 0, credential-token 0)");
    expect(lines).toContain("private term list: not loaded, generic rules only");
  });
});
