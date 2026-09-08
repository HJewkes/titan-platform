import { z } from "zod";
import { createRegistry, defineCommand, type BaseContext, type CommandRegistry } from "@titan-design/registry";
import type { Surface } from "./surface.js";

export interface TestContext extends BaseContext {
  surface: Surface;
}

export const createTestContext = (surface: Surface): TestContext => ({ warnings: [], format: "json", surface });

/** Two commands: one that succeeds with a warning, one that throws with a numeric code. */
export function createTestRegistry(): CommandRegistry<TestContext> {
  const registry = createRegistry<TestContext>();

  registry.register(
    defineCommand<{ name: string }, { greeting: string }, TestContext>({
      name: "greet",
      description: "Greet someone",
      args: z.object({ name: z.string() }),
      result: z.object({ greeting: z.string() }),
      async run(args, ctx) {
        ctx.warnings.push(`via ${ctx.surface}`);
        return { greeting: `hello ${args.name}` };
      },
    }),
  );

  registry.register(
    defineCommand<Record<string, never>, never, TestContext>({
      name: "boom",
      description: "Always throws",
      args: z.object({}),
      result: z.never(),
      async run() {
        throw Object.assign(new Error("kaboom"), { code: 78 });
      },
    }),
  );

  return registry;
}
