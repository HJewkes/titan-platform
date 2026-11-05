import type { AddressInfo } from "node:net";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";

export function portOf(server: { address(): AddressInfo | string | null }): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server is not listening on a port");
  return address.port;
}

/** `Object.assign` lets a test pin fields a locator's type does not name, as malformed stored data can. */
export const fakeLocator = (fields: object = {}): SourceTextLocator => Object.assign(partialFake<SourceTextLocator>(), fields);
