import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const steps = workflow.jobs["dag-check"].steps;
const keyStep = steps.find((step) => step.id === "key");
const restoreStep = steps.find((step) => step.id === "graph-cache");

const OUTPUT_REF = /^\$\{\{ steps\.key\.outputs\.(\w+) \}\}$/;
const PR_ONLY_REF = /^\$\{\{ github\.event_name == 'pull_request' && steps\.key\.outputs\.(\w+) \|\| '' \}\}$/;

/** Renders the restore-keys lines the way Actions would, for the two expression forms the step uses. */
function renderRestoreKeys(eventName, outputs) {
  const lines = restoreStep.with["restore-keys"].split("\n").map((line) => line.trim()).filter(Boolean);
  return lines
    .map((line) => {
      const plain = OUTPUT_REF.exec(line);
      if (plain) return outputs[plain[1]];
      const prOnly = PR_ONLY_REF.exec(line);
      if (prOnly) return eventName === "pull_request" ? outputs[prOnly[1]] : "";
      throw new Error(`restore-keys line this test cannot render: ${line}`);
    })
    .filter(Boolean);
}

describe("dag-check graph cache key", () => {
  let checkout;
  beforeEach(() => {
    checkout = mkdtempSync(path.join(tmpdir(), "dag-graph-key-"));
    mkdirSync(path.join(checkout, "packages/code-graph/src"), { recursive: true });
  });
  afterEach(() => rmSync(checkout, { recursive: true, force: true }));

  function computeKey(indexerSource) {
    writeFileSync(path.join(checkout, "packages/code-graph/src/indexer.ts"), indexerSource);
    const outputFile = path.join(checkout, "outputs");
    writeFileSync(outputFile, "");
    const result = spawnSync("bash", ["-e", "-c", keyStep.run], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, SOURCE_HASH: "feedface", GITHUB_OUTPUT: outputFile },
    });
    const lines = readFileSync(outputFile, "utf8").trim().split("\n").filter(Boolean);
    return { status: result.status, outputs: Object.fromEntries(lines.map((line) => line.split("="))) };
  }

  const indexer = 'import x from "y";\nexport const INDEX_VERSION = "7.8.9";\n';

  it("puts the indexer's INDEX_VERSION ahead of the source hash in the key", () => {
    const { status, outputs } = computeKey(indexer);

    expect(status).toBe(0);
    expect(outputs.version).toBe("dag-graph-iv7.8.9-");
    expect(outputs.prefix).toMatch(/^dag-graph-iv7\.8\.9-feedface-\d{4}-\d{2}-$/);
  });

  it("fails the step when indexer.ts no longer declares INDEX_VERSION", () => {
    const { status } = computeKey("export const VERSION = 1;\n");

    expect(status).not.toBe(0);
  });

  it("lets a pull request fall back to any graph at the same INDEX_VERSION, after the exact source prefix", () => {
    const { outputs } = computeKey(indexer);

    const keys = renderRestoreKeys("pull_request", outputs);

    expect(keys).toEqual([outputs.prefix, "dag-graph-iv7.8.9-"]);
  });

  it("gives main no restore key wider than the exact source prefix", () => {
    const { outputs } = computeKey(indexer);

    const keys = renderRestoreKeys("push", outputs);

    expect(keys).toEqual([outputs.prefix]);
    expect(restoreStep.with.key).toBe("${{ steps.key.outputs.prefix }}${{ github.sha }}");
  });
});
