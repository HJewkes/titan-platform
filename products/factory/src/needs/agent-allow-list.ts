import { createRpcClient, liveSource } from "@titan-design/rpc-client";

/** The initiatives an agent may see needs items from: an allow list, so a slug it does not name is withheld. */
export type AgentAllowList = () => Promise<ReadonlySet<string>>;

type InventoryRead = {
  inventory: { args: Record<string, never>; result: { initiatives: { slug: string; withheld_from_agents?: boolean }[] } };
};

/** active-work decides the verdict; a row an older daemon sends without the field reads as withheld. */
export function inventoryAllowList(origin: string, fetchImpl?: typeof fetch): AgentAllowList {
  const client = createRpcClient<InventoryRead>(liveSource({ origin, ...(fetchImpl && { fetch: fetchImpl }) }));
  return async () => {
    const { initiatives } = await client.call("inventory", {});
    return new Set(initiatives.filter((entry) => entry.withheld_from_agents === false).map((entry) => entry.slug));
  };
}
