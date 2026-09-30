import { describe, expect, it } from "vitest";
import tableJson from "./table.json" with { type: "json" };
import type { PolicyTable } from "./schema.js";
import { policyTableSchema } from "./schema.js";
import { DEFAULT_TABLE } from "./table.js";

function copyOfDefault(): PolicyTable {
  return structuredClone(DEFAULT_TABLE);
}

function withRule(table: PolicyTable, id: string, patch: Record<string, unknown>): PolicyTable {
  return { ...table, rules: table.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)) };
}

function issues(table: unknown): string[] {
  const result = policyTableSchema.safeParse(table);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("policyTableSchema", () => {
  it("accepts the shipped table.json as is", () => {
    expect(issues(tableJson)).toEqual([]);
    expect(DEFAULT_TABLE.rules).toHaveLength(91);
  });

  it("rejects a table missing one action by actor pair", () => {
    const table = copyOfDefault();
    table.rules = table.rules.filter((rule) => rule.id !== "SEC-WK");
    expect(issues(table)).toContain("no rule for secret-read by worker");
  });

  it("rejects a table with a duplicate pair", () => {
    const table = copyOfDefault();
    const duplicate = { ...table.rules.find((rule) => rule.id === "MRG-WK")!, id: "MRG-WK-2", verdict: "allow" as const };
    table.rules.push(duplicate);
    expect(issues(table)).toContain("duplicate rule for merge by worker");
  });

  it.each(["coordinator", "worker", "headless", "automation"])("rejects a gate that names %s as a resolver", (resolver) => {
    const table = withRule(copyOfDefault(), "MRG-CO", { resolvers: ["owner-terminal", resolver] });
    expect(issues(table)).not.toEqual([]);
  });

  it("rejects a gate with no resolvers and a non-gate row with resolvers", () => {
    expect(issues(withRule(copyOfDefault(), "MRG-CO", { resolvers: undefined }))).not.toEqual([]);
    expect(issues(withRule(copyOfDefault(), "MRG-WK", { resolvers: ["owner-terminal"] }))).not.toEqual([]);
  });

  it("does not count a conditional row toward a pair's one unconditional rule", () => {
    const table = copyOfDefault();
    table.rules = table.rules.filter((rule) => rule.id !== "MRG-AU");
    expect(issues(table)).toContain("no rule for merge by automation");
  });

  it("rejects when conditions on a gate or deny row", () => {
    expect(issues(withRule(copyOfDefault(), "MRG-WK", { when: ["merge-tree-clean"] }))).toContain("only an allow rule may carry when conditions");
    expect(issues(withRule(copyOfDefault(), "MRG-AU-RV", { verdict: "gate", resolvers: ["owner-terminal"] }))).not.toEqual([]);
  });

  it("rejects an unknown condition and a duplicate conditional id", () => {
    expect(issues(withRule(copyOfDefault(), "MRG-AU-RV", { when: ["looks-fine"] }))).not.toEqual([]);
    const table = copyOfDefault();
    table.rules.push({ ...table.rules.find((rule) => rule.id === "MRG-AU-RV")! });
    expect(issues(table)).toContain("duplicate rule id MRG-AU-RV");
  });
});
