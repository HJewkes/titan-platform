import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFixProofConfig } from "../packages/fix-proof/src/config.ts";
import { compileGlobs } from "../packages/fix-proof/src/glob.ts";
import { planFixProof, testOnlyReading } from "../packages/fix-proof/src/plan.ts";

const root = path.join(import.meta.dirname, "..");
const configText = readFileSync(path.join(root, ".github/fix-proof.json"), "utf8");
const parsed = parseFixProofConfig(configText);
if (!parsed.ok) throw new Error(`.github/fix-proof.json: ${parsed.error}`);
const { config } = parsed;
const isCarryOrTest = compileGlobs([...config.carry, ...config.tests]);
const isRuntime = compileGlobs(config.runtime);

function publishedEntries() {
  return ["packages", "products", "apps"].flatMap((tier) =>
    readdirSync(path.join(root, tier))
      .map((name) => `${tier}/${name}`)
      .filter((dir) => existsSync(path.join(root, dir, "package.json")))
      .flatMap((dir) => (JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8")).files ?? []).map((entry) => `${dir}/${entry}`)),
  );
}

// The probe covers a directory entry with nothing tracked under it yet; the tracked files cover a carry dir nested inside one.
function shippedPaths(entry, tracked) {
  return [entry, `${entry}/x`, ...tracked.filter((file) => file.startsWith(`${entry}/`))];
}

function readingOf(...lines) {
  const result = planFixProof({ nameStatus: `${lines.join("\n")}\n`, baseConfig: configText });
  if (!result.ok) throw new Error(result.error);
  return testOnlyReading(result.plan);
}

describe(".github/fix-proof.json runtime globs", () => {
  it("every published files entry under a carry glob is runtime", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");

    const unlisted = publishedEntries()
      .flatMap((entry) => shippedPaths(entry, tracked))
      .filter((file) => isCarryOrTest(file) && !isRuntime(file));

    expect(unlisted).toEqual([]);
  });

  it("console and agent-protocol fixtures read as source under the repo config", () => {
    const fixtures = [
      "packages/agent-protocol/fixtures/trace/v1/call.json",
      "apps/console/fixtures/rounds/r1/round.json",
      ".codewatch/fixtures/pr-report-clean.json",
    ];

    const reading = readingOf("A\tproducts/factory/src/a.test.ts", ...fixtures.map((fixture) => `M\t${fixture}`));

    expect(reading).toEqual({ testOnly: false, reason: "source", paths: [...fixtures].sort() });
  });

  it("Z8's test-support files still read test-only under the repo config", () => {
    const reading = readingOf(
      "A\t.changeset/z8-serve-restart-resume.md",
      "A\tproducts/factory/src/serve-restart-resume.test.ts",
      "A\tproducts/factory/src/test-support/serve-child-main.ts",
      "A\tpackages/pm/src/fixtures/a.json",
    );

    expect(reading).toEqual({ testOnly: true });
  });

  // TP-4656: tp#3025 read as a source diff only for its baseline prune, so its mutation specs never ran.
  it("a typed-lint burn-down of tests plus its eslint-suppressions baseline prune reads test-only", () => {
    const reading = readingOf(
      "A\t.changeset/typed-lint-tests.md",
      "M\tproducts/factory/eslint-suppressions.typed.json",
      "M\tpackages/egress-scan/eslint-suppressions.json",
      "M\tproducts/factory/src/shepherd/review.test.ts",
      "A\tproducts/factory/src/shepherd/review.test.mutations.json",
    );

    expect(reading).toEqual({ testOnly: true });
  });
});
