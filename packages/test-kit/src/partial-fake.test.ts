import { describe, expect, expectTypeOf, it } from "vitest";
import { partialFake } from "./partial-fake.js";

interface Client {
  name: string;
  retries: number;
  send(body: string): Promise<number>;
}

describe("partialFake", () => {
  it("returns the faked fields typed as the full interface", () => {
    const client = partialFake<Client>({ name: "probe" });

    expectTypeOf(client).toEqualTypeOf<Client>();
    expect(client.name).toBe("probe");
  });

  it("leaves a field the test did not fake undefined at run time", () => {
    const client = partialFake<Client>({ name: "probe" });

    expect(client.retries).toBeUndefined();
  });

  it("keeps a faked method callable", async () => {
    const client = partialFake<Client>({ send: async (body) => body.length });

    await expect(client.send("four")).resolves.toBe(4);
  });

  it("builds an empty fake when given no fields", () => {
    expect(partialFake<Client>()).toEqual({});
  });

  it("rejects a field the interface does not declare", () => {
    // @ts-expect-error `port` is not a field of Client, so a typo in a fake fails the typecheck.
    partialFake<Client>({ port: 1 });
  });
});
