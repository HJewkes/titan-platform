import { describe, expect, it } from "vitest";
import { MAX_LINE_CHARS, MAX_LINES_PER_FILE, ciPolicyChanges, shownLine } from "./ci-policy-changes.js";

const CI = ".github/workflows/ci.yml";

const workflow = (permission: string, jobs: string[]) => ["name: CI", "on: [pull_request]", "permissions:", `  contents: ${permission}`, "jobs:", ...jobs.flatMap((job) => [`  ${job}:`, `    name: ${job}`, "    runs-on: ubuntu-latest"])].join("\n");

describe("ciPolicyChanges", () => {
  it("shows a permission scope narrowed from write to read as a removed and an added line", () => {
    const changes = ciPolicyChanges(["permissions"], [{ path: CI, before: workflow("write", ["test"]), after: workflow("read", ["test"]) }]);

    expect(changes).toEqual([{ path: CI, key: "permissions", removed: ["  contents: write"], added: ["  contents: read"], omitted: 0 }]);
  });

  it("swapping base and head swaps removed and added", () => {
    const changes = ciPolicyChanges(["permissions"], [{ path: CI, before: workflow("read", ["test"]), after: workflow("write", ["test"]) }]);

    expect(changes).toEqual([{ path: CI, key: "permissions", removed: ["  contents: read"], added: ["  contents: write"], omitted: 0 }]);
  });

  it("shows a deleted egress-scan job's id and name lines under required-check", () => {
    const changes = ciPolicyChanges(["required-check"], [{ path: CI, before: workflow("read", ["test", "egress-scan"]), after: workflow("read", ["test"]) }]);

    expect(changes).toEqual([{ path: CI, key: "required-check", removed: ["  egress-scan:", "    name: egress-scan"], added: [], omitted: 0 }]);
  });

  it("reads the required context strings of .github/required-checks.json", () => {
    const before = '{\n  "contexts": [\n    "validate",\n    "egress-scan"\n  ]\n}';
    const after = '{\n  "contexts": [\n    "validate"\n  ]\n}';

    const changes = ciPolicyChanges(["required-check"], [{ path: ".github/required-checks.json", before, after }]);

    expect(changes).toEqual([{ path: ".github/required-checks.json", key: "required-check", removed: ['    "egress-scan"'], added: [], omitted: 0 }]);
  });

  it("reads secrets, pull_request_target and every ruleset line", () => {
    const files = [
      { path: CI, before: "on: [pull_request]\n", after: "on: [pull_request_target]\nenv:\n  TOKEN: ${{ secrets.NPM_TOKEN }}\n" },
      { path: ".github/rulesets/main.json", before: '{"enforcement": "active"}', after: '{"enforcement": "disabled"}' },
    ];

    const changes = ciPolicyChanges(["pull_request_target", "secrets", "ruleset"], files);

    expect(changes).toEqual([
      { path: CI, key: "pull_request_target", removed: [], added: ["on: [pull_request_target]"], omitted: 0 },
      { path: CI, key: "secrets", removed: [], added: ["  TOKEN: ${{ secrets.NPM_TOKEN }}"], omitted: 0 },
      { path: ".github/rulesets/main.json", key: "ruleset", removed: ['{"enforcement": "active"}'], added: ['{"enforcement": "disabled"}'], omitted: 0 },
    ]);
  });

  it("yields no lines for other, whatever the files changed", () => {
    expect(ciPolicyChanges(["other"], [{ path: CI, before: workflow("write", ["test"]), after: workflow("read", []) }])).toEqual([]);
  });

  it("caps a file at one line budget shared by its keys and counts the lines it left out", () => {
    const scopes = Array.from({ length: 15 }, (_, i) => `  scope-${i}: write`);
    const secrets = Array.from({ length: 15 }, (_, i) => `  S${i}: \${{ secrets.S${i} }}`);

    const [permissions, secret] = ciPolicyChanges(["permissions", "secrets"], [{ path: CI, before: [...scopes, ...secrets].join("\n"), after: "" }]);

    expect(permissions).toMatchObject({ removed: scopes, omitted: 0 });
    expect(secret?.removed).toHaveLength(MAX_LINES_PER_FILE - scopes.length);
    expect(secret?.omitted).toBe(scopes.length + secrets.length - MAX_LINES_PER_FILE);
  });

  it("cuts a long line to the character cap with an ellipsis", () => {
    const [change] = ciPolicyChanges(["secrets"], [{ path: CI, before: "", after: `  X: \${{ secrets.${"A".repeat(400)} }}` }]);

    expect(change?.added[0]).toHaveLength(MAX_LINE_CHARS);
    expect(change?.added[0]?.endsWith("…")).toBe(true);
  });

  it("strips an ANSI escape, a bidi override and a carriage return from an author's head line and its path", () => {
    const after = "  contents: \u001b[2K\u001b[1Gread‮\r\u0007\n";

    const [change] = ciPolicyChanges(["permissions"], [{ path: ".github/workflows/\u001b[31mci.yml", before: "", after }]);

    expect(change?.path).toBe(CI);
    expect(change?.added).toEqual(["  contents: read"]);
    // eslint-disable-next-line no-control-regex -- the assertion is that no control character survives
    expect(JSON.stringify(change)).not.toMatch(/[\u0000-\u001f\u007f-\u009f‮]|\\u00/);
  });
});

describe("shownLine", () => {
  it("keeps the indent and replaces a tab with spaces", () => {
    expect(shownLine("\tcontents: read  ")).toBe("  contents: read");
  });
});
