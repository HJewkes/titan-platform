import type { GateResolver } from "@titan-design/hitl";

/** The owner at a terminal, the resolver every test that answers a gate passes once the host runs the resolver migration. */
export const OWNER: GateResolver = Object.freeze({ class: "owner-terminal", id: "owner", channel: "test" });
