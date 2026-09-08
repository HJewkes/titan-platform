import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRegistry } from "./registry.js";
import { defineCommand } from "./types.js";

const noop = (name: string) =>
  defineCommand({
    name,
    description: name,
    args: z.object({}),
    result: z.void(),
    async run() {},
  });

describe("createRegistry", () => {
  it("registers and looks up commands by name", () => {
    const registry = createRegistry();
    registry.register(noop("task.add"));
    expect(registry.has("task.add")).toBe(true);
    expect(registry.get("task.add")?.name).toBe("task.add");
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.size).toBe(1);
  });

  it("throws when the same name is registered twice", () => {
    const registry = createRegistry();
    registry.register(noop("wrap"));
    expect(() => registry.register(noop("wrap"))).toThrow("Command already registered: wrap");
  });

  it("lists commands sorted by name regardless of registration order", () => {
    const registry = createRegistry();
    registry.register(noop("wrap"));
    registry.register(noop("task.add"));
    registry.register(noop("open"));
    expect(registry.list().map((c) => c.name)).toEqual(["open", "task.add", "wrap"]);
  });

  it("keeps separate registries independent", () => {
    const a = createRegistry();
    const b = createRegistry();
    a.register(noop("only-in-a"));
    expect(b.has("only-in-a")).toBe(false);
  });
});
