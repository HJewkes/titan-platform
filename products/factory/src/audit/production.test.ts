import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { systemAuditPorts } from "./production.js";

const checkout = fileURLToPath(new URL("../../../../", import.meta.url));
const noAgent = async (): Promise<unknown> => {
  throw new Error("no model call in tests");
};

describe("systemAuditPorts", () => {
  const ports = systemAuditPorts(checkout, noAgent);

  it("reads area ids from the checkout's area registry", async () => {
    await expect(ports.areas()).resolves.toEqual(expect.arrayContaining(["factory", "health", "shepherd"]));
  });

  it("reads no prior entry for an area that has never been audited", async () => {
    await expect(ports.prior("no-such-area")).resolves.toBeNull();
  });

  it("names the checkout's commit as the code revision", async () => {
    await expect(ports.codeRev()).resolves.toMatch(/^[0-9a-f]{40}$/);
  });
});
