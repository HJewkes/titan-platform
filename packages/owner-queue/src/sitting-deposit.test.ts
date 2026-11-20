import { describe, expect, it } from "vitest";
import { fromDeposit, ownerItemDepositSchema, type OwnerItemDeposit } from "./deposit.js";

const NOW = new Date("2031-01-01T00:00:00Z");
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const steps = (count: number): NonNullable<OwnerItemDeposit["steps"]> =>
  Array.from({ length: count }, (_, index) => ({ title: `Step ${index + 1}`, command: `example-cli step-${index + 1}` }));

function sitting(overrides: Partial<OwnerItemDeposit> = {}): OwnerItemDeposit {
  return {
    depositId: "sit-1",
    asker: "seat-a",
    kind: "do",
    door: "two-way",
    summary: "Terminal sitting: reinstall and check two tools",
    context: "Run these in order from a shell on the host.",
    steps: [
      { title: "Reinstall the tool", command: "example-cli install --global", verify: "example-cli --version prints 1.2.3" },
      { title: "Merge the release PR", command: "example-cli merge 7", op: { kind: "merge-at-head", repo: "acme/widgets", pr: 7, headSha: HEAD } },
    ],
    ...overrides,
  };
}

describe("a sitting deposit", () => {
  it("files its steps in order, each with its command, op and verify hint, as one open do item", () => {
    const item = fromDeposit(sitting(), NOW);

    expect(item.steps?.map((step) => step.title)).toEqual(["Reinstall the tool", "Merge the release PR"]);
    expect(item.steps?.[0]).toEqual({ title: "Reinstall the tool", command: "example-cli install --global", verify: "example-cli --version prints 1.2.3" });
    expect(item.steps?.[1]?.op).toEqual({ kind: "merge-at-head", repo: "acme/widgets", pr: 7, headSha: HEAD });
    expect(item).toMatchObject({ kind: "do", status: "open", lens: "blocking-agent" });
  });

  it("keeps a step op out of the item's keys, so a sitting never merges into the PR's own item", () => {
    expect(fromDeposit(sitting(), NOW).keys).toEqual([]);
  });

  it("accepts twenty steps and refuses twenty-one", () => {
    expect(ownerItemDepositSchema.safeParse(sitting({ steps: steps(20) })).success).toBe(true);
    expect(ownerItemDepositSchema.safeParse(sitting({ steps: steps(21) })).success).toBe(false);
  });

  it.each([
    ["no steps at all", { steps: [] }],
    ["a decide kind", { kind: "decide" as const }],
    ["options to pick from", { options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
    ["an op on the item", { op: { kind: "close-pr" as const, repo: "acme/widgets", pr: 7, headSha: HEAD } }],
    ["a step with an outcome already set", { steps: [{ title: "Run it", command: "example-cli run", outcome: "done" }] }],
    ["a step with no command", { steps: [{ title: "Run it", command: "" }] }],
    ["a two-line step title", { steps: [{ title: "Run\nit", command: "example-cli run" }] }],
  ])("refuses a sitting with %s", (_label, overrides) => {
    expect(ownerItemDepositSchema.safeParse({ ...sitting(), ...overrides }).success).toBe(false);
  });
});
