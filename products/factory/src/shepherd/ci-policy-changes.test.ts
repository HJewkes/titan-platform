import { describe, expect, it } from "vitest";
import { MAX_LINE_CHARS, MAX_LINES_PER_FILE, ciPolicyChanges, shownLine } from "./ci-policy-changes.js";

const CI = ".github/workflows/ci.yml";

const workflow = (permission: string, jobs: string[]) => ["name: CI", "on: [pull_request]", "permissions:", `  contents: ${permission}`, "jobs:", ...jobs.flatMap((job) => [`  ${job}:`, `    name: ${job}`, "    runs-on: ubuntu-latest"])].join("\n");

describe("ciPolicyChanges", () => {
  it("shows a permission scope narrowed from write to read as a removed and an added line", () => {
    const changes = ciPolicyChanges(["permissions"], [{ path: CI, before: workflow("write", ["test"]), after: workflow("read", ["test"]) }]);

    expect(changes).toEqual([{ path: CI, key: "permissions", removed: ["L4:  contents: write"], added: ["L4:  contents: read"], omitted: 0 }]);
  });

  it("swapping base and head swaps removed and added", () => {
    const changes = ciPolicyChanges(["permissions"], [{ path: CI, before: workflow("read", ["test"]), after: workflow("write", ["test"]) }]);

    expect(changes).toEqual([{ path: CI, key: "permissions", removed: ["L4:  contents: read"], added: ["L4:  contents: write"], omitted: 0 }]);
  });

  it("shows a deleted egress-scan job's id and name lines under required-check", () => {
    const changes = ciPolicyChanges(["required-check"], [{ path: CI, before: workflow("read", ["test", "egress-scan"]), after: workflow("read", ["test"]) }]);

    expect(changes).toEqual([{ path: CI, key: "required-check", removed: ["L9:  egress-scan:", "L10:    name: egress-scan"], added: [], omitted: 0 }]);
  });

  it("reads the required context strings of .github/required-checks.json", () => {
    const before = '{\n  "contexts": [\n    "validate",\n    "egress-scan"\n  ]\n}';
    const after = '{\n  "contexts": [\n    "validate"\n  ]\n}';

    const changes = ciPolicyChanges(["required-check"], [{ path: ".github/required-checks.json", before, after }]);

    expect(changes).toEqual([{ path: ".github/required-checks.json", key: "required-check", removed: ['L4:    "egress-scan"'], added: [], omitted: 0 }]);
  });

  it("reads secrets, pull_request_target and every ruleset line", () => {
    const files = [
      { path: CI, before: "on: [pull_request]\n", after: "on: [pull_request_target]\nenv:\n  TOKEN: ${{ secrets.NPM_TOKEN }}\n" },
      { path: ".github/rulesets/main.json", before: '{"enforcement": "active"}', after: '{"enforcement": "disabled"}' },
    ];

    const changes = ciPolicyChanges(["pull_request_target", "secrets", "ruleset"], files);

    expect(changes).toEqual([
      { path: CI, key: "pull_request_target", removed: [], added: ["L1:on: [pull_request_target]"], omitted: 0 },
      { path: CI, key: "secrets", removed: [], added: ["L3:  TOKEN: ${{ secrets.NPM_TOKEN }}"], omitted: 0 },
      { path: ".github/rulesets/main.json", key: "ruleset", removed: ['L1:{"enforcement": "active"}'], added: ['L1:{"enforcement": "disabled"}'], omitted: 0 },
    ]);
  });

  it("yields no lines for other, whatever the files changed", () => {
    expect(ciPolicyChanges(["other"], [{ path: CI, before: workflow("write", ["test"]), after: workflow("read", []) }])).toEqual([]);
  });

  it("splits at a bare CR as YAML does, so a job joined onto one line cannot hide its write-all behind a decoy edit", () => {
    const before = "permissions:\n  contents: read\njobs:\n  test:\n    runs-on: x\n";
    const after = "permissions:\n  contents: read # pinned\njobs:\n  test:\n    runs-on: x\n  pub:\r    permissions: write-all\r    runs-on: x\n";

    const changes = ciPolicyChanges(["permissions"], [{ path: CI, before, after }]);

    expect(changes).toEqual([{ path: CI, key: "permissions", removed: ["L2:  contents: read"], added: ["L2:  contents: read # pinned", "L7:    permissions: write-all"], omitted: 0 }]);
  });

  it("shows two jobs that trade read and write, which a set comparison would cancel", () => {
    const job = (name: string, scope: string) => [`  ${name}:`, "    permissions:", `      contents: ${scope}`];
    const before = ["jobs:", ...job("test", "read"), ...job("pub", "write"), ""].join("\n");
    const after = ["jobs:", ...job("test", "write"), ...job("pub", "read"), ""].join("\n");

    const [change] = ciPolicyChanges(["permissions"], [{ path: CI, before, after }]);

    expect(change).toMatchObject({ removed: ["L4:      contents: read", "L7:      contents: write"], added: ["L4:      contents: write", "L7:      contents: read"] });
  });

  it("shows an added line whose text already appears elsewhere in the file", () => {
    const before = "jobs:\n  test:\n    permissions:\n      contents: write\n";
    const after = `${before}  pub:\n    permissions:\n      contents: write\n`;

    const [change] = ciPolicyChanges(["permissions"], [{ path: CI, before, after }]);

    expect(change).toMatchObject({ removed: [], added: ["L6:    permissions:", "L7:      contents: write"] });
  });

  it("caps a file at one line budget shared by its keys and counts the lines it left out", () => {
    const scopes = Array.from({ length: 15 }, (_, i) => `  scope-${i}: write`);
    const secrets = Array.from({ length: 15 }, (_, i) => `  S${i}: \${{ secrets.S${i} }}`);

    const [permissions, secret] = ciPolicyChanges(["permissions", "secrets"], [{ path: CI, before: [...scopes, ...secrets].join("\n"), after: "" }]);

    expect(permissions).toMatchObject({ removed: scopes.map((scope, i) => `L${i + 1}:${scope}`), omitted: 0 });
    expect(secret?.removed).toHaveLength(MAX_LINES_PER_FILE - scopes.length);
    expect(secret?.omitted).toBe(scopes.length + secrets.length - MAX_LINES_PER_FILE);
  });

  it("cuts a long line to the character cap with an ellipsis", () => {
    const [change] = ciPolicyChanges(["secrets"], [{ path: CI, before: "", after: `  X: \${{ secrets.${"A".repeat(400)} }}` }]);

    expect(change?.added[0]).toHaveLength(MAX_LINE_CHARS);
    expect(change?.added[0]?.endsWith("…")).toBe(true);
  });

  it("strips an ANSI escape, a bidi override and a zero-width space from an author's head line and its path", () => {
    const after = "  contents: \u001b[2K\u001b[1Gre\u200bad\u202e\u0007\n";

    const [change] = ciPolicyChanges(["permissions"], [{ path: ".github/workflows/\u001b[31mci.yml\ufeff", before: "", after }]);

    expect(change?.path).toBe(CI);
    expect(change?.added).toEqual(["L1:  contents: read"]);
    // eslint-disable-next-line no-control-regex -- the assertion is that no control character survives
    expect(JSON.stringify(change)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b\u202e\ufeff]|\\u00/);
  });

  it("splits at a line or paragraph separator and strips one from a path, so neither can fake an unprefixed card line", () => {
    const after = `  X: \${{ secrets.A }}\u2028- contents: write\u2029.github/x.yml (permissions):`;

    const changes = ciPolicyChanges(["secrets", "permissions"], [{ path: `.github/workflows/ci.yml\u2028+ contents: read`, before: "", after }]);

    expect(changes.map((change) => change.path)).toEqual([".github/workflows/ci.yml+ contents: read", ".github/workflows/ci.yml+ contents: read"]);
    expect(changes.map((change) => change.added)).toEqual([["L1:  X: ${{ secrets.A }}"], ["L2:- contents: write"]]);
    expect(JSON.stringify(changes)).not.toMatch(/[\u2028\u2029]/);
  });
});

describe("shownLine", () => {
  it("keeps the indent and replaces a tab with spaces", () => {
    expect(shownLine("\tcontents: read  ")).toBe("  contents: read");
  });
});
