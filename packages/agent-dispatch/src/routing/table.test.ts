import fs from "node:fs";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { DEFAULT_WORKFLOW_TABLE } from "./node.js";
import { parseWorkflowTable } from "./table.js";

type Rows = Record<string, Record<string, unknown>>;
interface RawTable {
  workflow: Rows;
  priorWorkflow: Record<string, string>;
  priors: Record<string, unknown>[];
}

const isRawTable = (value: unknown): value is RawTable => typeof value === "object" && value !== null;

const shippedText = fs.readFileSync(DEFAULT_WORKFLOW_TABLE, "utf8");
function shippedTable(): RawTable {
  const raw: unknown = parse(shippedText);
  if (!isRawTable(raw)) throw new Error("the shipped table is not a mapping");
  return raw;
}
const lint = (table: unknown) => parseWorkflowTable(stringify(table)).problems;

describe("the workflow table this package ships", () => {
  it("passes the lint with all eleven classes and eight priors", () => {
    const read = parseWorkflowTable(shippedText);

    expect(read.problems).toBeUndefined();
    expect(Object.keys(read.table!.workflow)).toHaveLength(11);
    expect(read.table!.priors.map((rule) => rule.prior)).toEqual([
      "one-way",
      "safety-path",
      "ui-round",
      "cross-package",
      "agent-text",
      "small",
      "standard",
      "needs-plan",
    ]);
  });

  it("refuses to route the size rows down without owns", () => {
    const sizeRows = parseWorkflowTable(shippedText).table!.priors.filter((rule) => rule.estimateAtMost !== undefined);

    expect(sizeRows.map((rule) => [rule.prior, rule.needsOwns])).toEqual([
      ["small", true],
      ["standard", true],
    ]);
  });
});

describe("the workflow table lint", () => {
  it("refuses an unknown class key in workflow", () => {
    const table = shippedTable();
    table.workflow["big-bang"] = table.workflow["local-fix"]!;

    expect(lint(table)).toEqual(['at workflow: unknown class "big-bang"']);
  });

  it("refuses an unknown class a prior is sent to", () => {
    const table = shippedTable();
    table.priorWorkflow.small = "tiny-fix";

    expect(lint(table)).toEqual(['at priorWorkflow.small: unknown class "tiny-fix"']);
  });

  it("refuses an unknown prior in a rule", () => {
    const table = shippedTable();
    table.priors[2]!.prior = "visual";

    expect(lint(table)).toEqual(['at priors.2.prior: unknown prior "visual"']);
  });

  it("refuses an unknown implementer profile, split or not", () => {
    const table = shippedTable();
    table.workflow["agent-text"]!.implementer = "bd-implementer-max";
    table.workflow["local-fix"]!.implementerAbove2 = "opus";

    expect(lint(table)).toEqual([
      'at workflow.agent-text.implementer: unknown implementer profile "bd-implementer-max"',
      'at workflow.local-fix.implementerAbove2: unknown implementer profile "opus"',
    ]);
  });

  it.each([
    ["review", "owner-only", 'unknown review ladder value "owner-only"'],
    ["merge", "MRG-AU-XX", 'unknown merge ladder value "MRG-AU-XX"'],
  ])("refuses an unknown %s ladder value", (column, value, message) => {
    const table = shippedTable();
    table.workflow.mechanical![column] = value;

    expect(lint(table)).toEqual([`at workflow.mechanical.${column}: ${message}`]);
  });

  it("refuses a misspelt key", () => {
    const table = shippedTable();
    table.workflow.inert!.reveiw = "ci";

    expect(lint(table)).toEqual(['at workflow.inert: Unrecognized key: "reveiw"']);
  });

  it("refuses a priors list with no fallback row last", () => {
    const table = shippedTable();
    table.priors.pop();

    expect(lint(table)).toEqual(["priors has no fallback row last"]);
  });

  it("refuses a rule naming a path list the file does not define", () => {
    const table = shippedTable();
    table.priors[2]!.owns = "visuals";

    expect(lint(table)).toEqual(['at priors.2.owns: unknown path list "visuals"']);
  });

  it("refuses a needsOwns that is not a boolean", () => {
    const table = shippedTable();
    table.priors[6]!.needsOwns = "yes";

    expect(lint(table)).toEqual(["at priors.6.needsOwns: Invalid input: expected boolean, received string"]);
  });
});
