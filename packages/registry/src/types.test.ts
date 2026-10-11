import { describe, expect, it } from "vitest";
import { z } from "zod";
import { commandToTool, createRegistry, defineCommand, type AnyCommand, type BaseContext, type Command } from "./index.js";

interface ProductContext extends BaseContext {
  root: string;
}

const needsRoot = defineCommand<Record<string, never>, string, ProductContext>({
  name: "root.show",
  description: "Answer the product root",
  args: z.object({}),
  result: z.string(),
  run: async (_args, ctx) => ctx.root,
});

describe("a command's context", () => {
  it("cannot be widened to one that lacks the fields its run reads", () => {
    // @ts-expect-error a base context has no root, so this run cannot be served with one
    const annotated: Command<Record<string, never>, string> = needsRoot;
    // @ts-expect-error the same for AnyCommand
    const list: AnyCommand[] = [needsRoot];
    // @ts-expect-error a base-context registry cannot hold it
    createRegistry().register(needsRoot);

    expect([annotated, ...list]).toEqual([needsRoot, needsRoot]);
  });

  it("can be narrowed: a base-context command serves a product registry", () => {
    const ping = defineCommand<Record<string, never>, "pong">({
      name: "ping",
      description: "Answer pong",
      args: z.object({}),
      result: z.literal("pong"),
      run: async () => "pong" as const,
    });
    const registry = createRegistry<ProductContext>();

    registry.register(ping);

    expect(registry.list()).toEqual([ping]);
  });

  it("does not matter to code that reads a command but never runs it", () => {
    expect(commandToTool(needsRoot, { prefix: "p__" }).name).toBe("p__root__show");
  });
});
