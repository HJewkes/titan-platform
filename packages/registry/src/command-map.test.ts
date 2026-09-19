import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { CommandMap } from "@titan-design/rpc-protocol";
import { defineCommand, type BaseContext, type CommandMapOf } from "./index.js";

interface ProductContext extends BaseContext {
  root: string;
}

const taskList = defineCommand<{ status?: "open" | "done" }, { slugs: string[] }, ProductContext>({
  name: "task.list",
  description: "List tasks",
  args: z.object({ status: z.enum(["open", "done"]).optional() }),
  result: z.object({ slugs: z.array(z.string()) }),
  run: async () => ({ slugs: [] }),
});

const ping = defineCommand<Record<string, never>, "pong">({
  name: "ping",
  description: "Answer pong",
  args: z.object({}),
  result: z.literal("pong"),
  run: async () => "pong" as const,
});

const commands = { "task.list": taskList, ping };
type Map = CommandMapOf<typeof commands>;

describe("CommandMapOf", () => {
  it("derives each command's args and result under its key", () => {
    expectTypeOf<Map["task.list"]>().toEqualTypeOf<{ args: { status?: "open" | "done" }; result: { slugs: string[] } }>();
    expectTypeOf<Map["ping"]>().toEqualTypeOf<{ args: Record<string, never>; result: "pong" }>();
    expect(Object.keys(commands)).toEqual(["task.list", "ping"]);
  });

  it("produces a map a CommandMap-generic client accepts, with only the given keys", () => {
    expectTypeOf<Map>().toMatchTypeOf<CommandMap>();
    expectTypeOf<keyof Map>().toEqualTypeOf<"task.list" | "ping">();
  });

  it("rejects values that are not commands", () => {
    // @ts-expect-error a plain function is not a command definition
    type NotCommands = CommandMapOf<{ "x.y": () => void }>;
    expectTypeOf<NotCommands>().not.toBeNever();
  });
});
