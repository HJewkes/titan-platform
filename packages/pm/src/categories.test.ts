import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  CategoryRegistrySchema,
  categoriesPath,
  checkCategories,
  parseCategoryRegistry,
  type CategorizedTask,
  type CategoryRegistry,
} from "./categories.js";
import { TaskSchema } from "./task.js";

const registry: CategoryRegistry = {
  kind: ["epic", "feature", "platform"],
  status: [
    { id: "open", closed: false, dispatchable: true },
    { id: "done", closed: true, dispatchable: false },
    { id: "wont-do", closed: true, dispatchable: false },
    { id: "icebox", closed: false, dispatchable: false },
  ],
  cos: ["standard", "fixed"],
  area: [
    { id: "pm", tier: 2, path: "packages/pm" },
    { id: "relay", tier: "product" },
  ],
};

const task = (extra: Partial<CategorizedTask> = {}): CategorizedTask => ({ id: "AA-1", status: "open", ...extra });

describe("CategoryRegistrySchema", () => {
  it("accepts a registry with the required statuses and kind", () => {
    expect(CategoryRegistrySchema.safeParse(registry).success).toBe(true);
  });

  it.each(["open", "done", "wont-do", "icebox"])("rejects a registry without status %s", (id) => {
    const result = CategoryRegistrySchema.safeParse({ ...registry, status: registry.status.filter((s) => s.id !== id) });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain(`must include: ${id}`);
  });

  it("rejects a registry without kind epic", () => {
    const result = CategoryRegistrySchema.safeParse({ ...registry, kind: ["feature"] });
    expect(result.error?.issues.map((i) => i.message)).toContain("must include: epic");
  });

  it("rejects a repeated id on an axis", () => {
    const result = CategoryRegistrySchema.safeParse({ ...registry, area: [...registry.area, { id: "pm", tier: 2 }] });
    expect(result.error?.issues.map((i) => i.message)).toContain("repeated ids: pm");
  });

  it("rejects a status entry without its closed and dispatchable flags", () => {
    const status = [...registry.status, { id: "blocked" }];
    expect(CategoryRegistrySchema.safeParse({ ...registry, status }).success).toBe(false);
  });

  it.each([3, "app", "0"])("rejects area tier %s", (tier) => {
    const area = [{ id: "pm", tier }];
    expect(CategoryRegistrySchema.safeParse({ ...registry, area }).success).toBe(false);
  });

  it.each(["Feature", "wont do", "-x", ""])("rejects category id %j", (id) => {
    expect(CategoryRegistrySchema.safeParse({ ...registry, cos: [id] }).success).toBe(false);
  });
});

describe("categoriesPath", () => {
  it("puts the registry in the titan-platform initiative of the root", () => {
    expect(categoriesPath("/root")).toBe("/root/titan-platform/categories.yml");
  });

  it("does not double a trailing slash", () => {
    expect(categoriesPath("/root/")).toBe("/root/titan-platform/categories.yml");
  });
});

describe("parseCategoryRegistry", () => {
  it("reads a missing file as a null registry", () => {
    expect(parseCategoryRegistry(undefined)).toBeNull();
  });

  it("returns the parsed registry", () => {
    expect(parseCategoryRegistry(registry)).toEqual(registry);
  });

  it("throws on an empty file rather than skipping validation", () => {
    expect(() => parseCategoryRegistry(parse(""))).toThrow();
  });
});

describe("checkCategories", () => {
  it("accepts a task whose values are all in the registry", () => {
    const valid = task({ kind: "epic", status: "icebox", cos: "fixed", area: "relay", due: "2026-11-02" });
    expect(checkCategories(valid, registry)).toEqual([]);
  });

  it("returns one error per unknown value, naming the axis and the allowed values", () => {
    const errors = checkCategories(task({ kind: "chore", status: "closed", cos: "rush", area: "nowhere" }), registry);
    expect(errors).toEqual([
      { kind: "unknown-category", id: "AA-1", axis: "kind", value: "chore", allowed: ["epic", "feature", "platform"] },
      {
        kind: "unknown-category",
        id: "AA-1",
        axis: "status",
        value: "closed",
        allowed: ["open", "done", "wont-do", "icebox"],
      },
      { kind: "unknown-category", id: "AA-1", axis: "cos", value: "rush", allowed: ["standard", "fixed"] },
      { kind: "unknown-category", id: "AA-1", axis: "area", value: "nowhere", allowed: ["pm", "relay"] },
    ]);
  });

  it("does not check an axis the task leaves unset", () => {
    expect(checkCategories(task(), registry)).toEqual([]);
  });

  it("reports cos fixed without a due date", () => {
    expect(checkCategories(task({ cos: "fixed" }), registry)).toEqual([{ kind: "cos-fixed-without-due", id: "AA-1" }]);
  });

  describe("with no registry", () => {
    it.each(["open", "done"])("accepts the built-in status %s", (status) => {
      expect(checkCategories(task({ status }), null)).toEqual([]);
    });

    it("rejects a status outside the built-in set", () => {
      expect(checkCategories(task({ status: "icebox" }), null)).toEqual([
        { kind: "unknown-category", id: "AA-1", axis: "status", value: "icebox", allowed: ["open", "done"] },
      ]);
    });

    it("skips kind, cos and area", () => {
      expect(checkCategories(task({ kind: "chore", cos: "rush", area: "nowhere" }), null)).toEqual([]);
    });

    it("still reports cos fixed without a due date", () => {
      expect(checkCategories(task({ cos: "fixed" }), null)).toEqual([{ kind: "cos-fixed-without-due", id: "AA-1" }]);
    });

    it.each(["SI-1.yml", "SI-2.yml"])("accepts the active-work fixture %s", (name) => {
      const fixture = parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
      expect(checkCategories(TaskSchema.parse(fixture), null)).toEqual([]);
    });
  });
});
