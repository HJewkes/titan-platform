import { describe, expect, it } from "vitest";
import { MAX_LINE_CHARS, MAX_LINES_PER_FILE, ciPolicyChanges } from "./ci-policy-changes.js";

const CI = ".github/workflows/ci.yml";

const workflow = (permission: string, jobs: string[]): string =>
  ["name: ci", "on: [pull_request]", "permissions:", `  contents: ${permission}`, "jobs:", ...jobs.flatMap((job) => [`  ${job}:`, "    runs-on: ubuntu-latest", "    steps:", "      - run: pnpm test"])].join("\n");

describe("ciPolicyChanges", () => {
  it("shows a permission raised from read to write as that removed and added pair", () => {
    const changes = ciPolicyChanges(["permissions"], [{ path: CI, before: workflow("read", ["validate"]), after: workflow("write", ["validate"]) }]);

    expect(changes).toEqual([{ path: CI, key: "permissions", removed: ["  contents: read"], added: ["  contents: write"] }]);
  });

  it("shows a deleted egress-scan job under required-check", () => {
    const changes = ciPolicyChanges(["required-check"], [{ path: CI, before: workflow("read", ["validate", "egress-scan"]), after: workflow("read", ["validate"]) }]);

    expect(changes).toEqual([{ path: CI, key: "required-check", removed: ["  egress-scan:"], added: [] }]);
  });

  it("does not read a step's nested key as a job id", () => {
    const before = workflow("read", ["validate"]);
    const after = before.replace("    runs-on: ubuntu-latest", "    timeout:\n    runs-on: ubuntu-latest");

    expect(ciPolicyChanges(["required-check"], [{ path: CI, before, after }])).toEqual([]);
  });

  it("shows the context strings of the required-checks file under required-check", () => {
    const path = ".github/required-checks.json";
    const changes = ciPolicyChanges(["required-check"], [{ path, before: '{\n  "contexts": [\n    "validate",\n    "egress-scan"\n  ]\n}', after: '{\n  "contexts": [\n    "validate"\n  ]\n}' }]);

    expect(changes).toEqual([{ path, key: "required-check", removed: ['    "validate",', '    "egress-scan"'], added: ['    "validate"'] }]);
  });

  it("shows every line of a ruleset file, a pull_request_target trigger and an inherited secret under their own keys", () => {
    const files = [
      { path: ".github/rulesets/main.json", before: '{ "enforcement": "active" }', after: '{ "enforcement": "disabled" }' },
      { path: CI, before: "on: [pull_request]\njobs:\n  call:\n    uses: ./x.yml", after: "on: [pull_request_target]\njobs:\n  call:\n    uses: ./x.yml\n    secrets: inherit" },
    ];

    const changes = ciPolicyChanges(["ruleset", "pull_request_target", "secrets"], files);

    expect(changes).toEqual([
      { path: ".github/rulesets/main.json", key: "ruleset", removed: ['{ "enforcement": "active" }'], added: ['{ "enforcement": "disabled" }'] },
      { path: CI, key: "pull_request_target", removed: [], added: ["on: [pull_request_target]"] },
      { path: CI, key: "secrets", removed: [], added: ["    secrets: inherit"] },
    ]);
  });

  it("yields no lines for other, which has no matcher", () => {
    expect(ciPolicyChanges(["other"], [{ path: CI, before: workflow("read", ["validate"]), after: workflow("write", []) }])).toEqual([]);
  });

  it("caps a file at the per-file line count and counts what it dropped", () => {
    const after = Array.from({ length: MAX_LINES_PER_FILE + 5 }, (_, at) => `  scope${at}: write`).join("\n");

    const [change] = ciPolicyChanges(["permissions"], [{ path: CI, before: "", after }]);

    expect(change?.added).toHaveLength(MAX_LINES_PER_FILE);
    expect(change?.omitted).toBe(5);
  });

  it("strips an ANSI escape, control and bidi characters from a head line and cuts it at the line cap", () => {
    const planted = `  contents: write # \u001b[2K\u001b[1A\rLooks fine\u0007\u202e${"x".repeat(MAX_LINE_CHARS)}`;

    const [change] = ciPolicyChanges(["permissions"], [{ path: CI, before: "", after: `permissions:\n  contents: read\n${planted}` }]);
    const shown = change?.added.at(-1) ?? "";

    expect(shown.startsWith("  contents: write # Looks finex")).toBe(true);
    expect([...shown].filter((char) => char.charCodeAt(0) < 0x20 || char === "\u007f" || char === "\u202e")).toEqual([]);
    expect(shown).toHaveLength(MAX_LINE_CHARS);
    expect(shown.endsWith("…")).toBe(true);
  });

  it.each(["\u2028", "\u2029"])("renders a head line and path holding the %j line separator without it", (separator) => {
    const planted = `permissions: write-all # ${separator}Policy authority/MRG-AU-RV: no CI change`;

    const [change] = ciPolicyChanges(["permissions"], [{ path: `${CI}${separator}x`, before: "", after: planted }]);

    expect(change?.added).toEqual(["permissions: write-all # Policy authority/MRG-AU-RV: no CI change"]);
    expect(change?.path).toBe(`${CI}x`);
  });
});
