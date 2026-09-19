import { describe, expect, expectTypeOf, it } from "vitest";
import { EXIT, errorEnvelope, successEnvelope, type CommandMap } from "@titan-design/rpc-protocol";
import { RpcError, createRpcClient, type CommandName } from "./client.js";
import { snapshotKey } from "./canonical-key.js";
import { SNAPSHOT_FORMAT } from "./snapshot.js";
import { staticSource } from "./static-source.js";

type Commands = {
  "task.list": { args: { status?: "open" | "done" }; result: { slugs: string[] } };
  "task.get": { args: { slug: string }; result: { slug: string; title: string } };
};

const client = createRpcClient<Commands>(
  staticSource({
    snapshot: {
      format: SNAPSHOT_FORMAT,
      createdAt: "2026-09-18T00:00:00.000Z",
      calls: {
        [snapshotKey("task.list", {})]: successEnvelope({ slugs: ["a", "b"] }),
        [snapshotKey("task.get", { slug: "a" })]: successEnvelope({ slug: "a", title: "A" }),
        [snapshotKey("task.get", { slug: "zzz" })]: errorEnvelope("No task zzz", EXIT.NOINPUT),
      },
    },
  }),
);

describe("createRpcClient types", () => {
  it("types each call's args and result from the command map", async () => {
    const task = await client.call("task.get", { slug: "a" });
    expectTypeOf(task).toEqualTypeOf<{ slug: string; title: string }>();
    expect(task.title).toBe("A");
  });

  it("lets args be omitted only when every field is optional", async () => {
    expect(await client.call("task.list")).toEqual({ slugs: ["a", "b"] });
    // @ts-expect-error task.get requires a slug
    await client.call("task.get").catch(() => undefined);
  });

  it("rejects unknown command names, wrong args, and wrong result use at compile time", async () => {
    // @ts-expect-error no such command
    await client.call("task.delete", {}).catch(() => undefined);
    // @ts-expect-error slug must be a string
    await client.call("task.get", { slug: 1 }).catch(() => undefined);
    // @ts-expect-error status must be open or done
    await client.call("task.list", { status: "archived" }).catch(() => undefined);
    // @ts-expect-error unknown arg field
    await client.call("task.get", { slug: "a", force: true }).catch(() => undefined);
    const listed = await client.call("task.list", {});
    // @ts-expect-error the result has slugs, not tasks
    expect(listed.tasks).toBeUndefined();
    // @ts-expect-error slugs are strings
    const first: number = listed.slugs[0]!;
    expect(first).toBe("a");
  });
});

describe("createRpcClient with an interface map", () => {
  interface Declared extends CommandMap {
    "task.get": { args: { slug: string }; result: { title: string } };
  }

  it("still rejects names the interface does not declare, despite CommandMap's index signature", async () => {
    const declared = createRpcClient<Declared>(client.source);
    // @ts-expect-error no such command, even though CommandMap is Record<string, ...>
    await declared.call("task.delete", {}).catch(() => undefined);
    expectTypeOf<CommandName<Declared>>().toEqualTypeOf<"task.get">();
  });

  it("falls back to any name for the bare CommandMap", () => {
    expectTypeOf<CommandName<CommandMap>>().toEqualTypeOf<string>();
  });
});

describe("createRpcClient errors", () => {
  it("rejects a failure envelope with an RpcError carrying the exit code and command", async () => {
    const error = await client.call("task.get", { slug: "zzz" }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ name: "RpcError", command: "task.get", code: EXIT.NOINPUT, message: "No task zzz" });
  });
});
