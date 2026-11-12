import { policyTablesOf, type PolicyTable } from "./g10-class-rules.js";
import { riskFactsOf, riskTier } from "./risk-tier.js";

/**
 * TP-5403 (owner triage q28 A): the policy tables a touch may go low on. A table not named here, one added later
 * included, keeps the owner gate; nothing lists the tables that are blocked.
 */
const LOW_POLICY_TABLES: readonly PolicyTable[] = ["default-policy", "signoff-policy", "hold-closure"];

type LowTierPolicy = { eligible: true; tables: PolicyTable[] } | { eligible: false; kept: string };

type LowTierRead = Parameters<typeof riskFactsOf>[0];

const kept = (reason: string): LowTierPolicy => ({ eligible: false, kept: reason });

/** Every policy path must sit only in allowed tables; a path no table names, or one in any other table, keeps the gate. */
function byTables(tablesOf: ReadonlyMap<string, readonly PolicyTable[]>): LowTierPolicy {
  const found = new Set<PolicyTable>();
  for (const [path, tables] of tablesOf) {
    if (tables.length === 0) return kept(`policy path in no named table ${path}`);
    if (!tables.every((table) => LOW_POLICY_TABLES.includes(table))) return kept(tables.find((table) => !LOW_POLICY_TABLES.includes(table)) ?? path);
    for (const table of tables) found.add(table);
  }
  return found.size > 0 ? { eligible: true, tables: LOW_POLICY_TABLES.filter((table) => found.has(table)) } : kept("no policy table");
}

function classify(read: LowTierRead): LowTierPolicy {
  const facts = riskFactsOf(read);
  if (!facts.touches.includes("policy")) return kept("no policy touch");
  const adversary = facts.touches.filter((touch) => touch === "authority" || touch === "security");
  if (adversary.length > 0) return kept(`${adversary.join(", ")} touch`);
  const tier = riskTier({ ...facts, touches: facts.touches.filter((touch) => touch !== "policy") });
  if (tier.tier !== "low") return kept(tier.reasons[0] ?? `${tier.tier} tier`);
  return byTables(policyTablesOf(read.paths.map((path) => ({ path }))));
}

/**
 * Whether a policy touch is low tier at a head: policy is its only adversary touch and the only fact raising its tier,
 * and every policy path comes from an allowed table. Pure; anything it cannot judge, a throw included, keeps the gate.
 */
export function lowTierPolicyTouch(read: LowTierRead): LowTierPolicy {
  try {
    return classify(read);
  } catch {
    return kept("low-tier classifier failed");
  }
}
