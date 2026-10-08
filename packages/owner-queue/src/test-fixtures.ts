import type { OwnerItem } from "./schema.js";

export const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
export const SHA_B = "0f1e2d3c4b5a69788796a5b4c3d2e1f098765432";

export function item(overrides: Partial<OwnerItem> & Pick<OwnerItem, "id">): OwnerItem {
  return {
    sources: [{ system: "agent-chat", ref: overrides.id }],
    kind: "decide",
    door: "two-way",
    summary: "Example question",
    context: "Example context",
    keys: [],
    personal: false,
    lens: "planning",
    unblocks: [],
    openedAt: "2026-01-01T00:00:00Z",
    status: "open",
    ...overrides,
  };
}
