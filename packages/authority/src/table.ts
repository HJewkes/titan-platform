import tableJson from "./table.json" with { type: "json" };
import type { PolicyTable } from "./schema.js";
import { policyTableSchema } from "./schema.js";

/** The owner-approved decision table, validated on load. The same data ships as `@titan-design/authority/table.json`. */
export const DEFAULT_TABLE: PolicyTable = policyTableSchema.parse(tableJson);
