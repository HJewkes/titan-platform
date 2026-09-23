/** The audit's pinned pyright selection: checks whose finding is a guard or conversion the types already make redundant. */
export const AUDIT_PYRIGHT_RULES: readonly string[] = [
  "reportUnnecessaryIsInstance",
  "reportUnnecessaryComparison",
  "reportUnnecessaryContains",
  "reportUnnecessaryCast",
];

// typeCheckingMode "off" still leaves these on, and an audit that cannot see the project's dependencies would drown in them.
const STILL_ON_WHEN_OFF = ["reportMissingImports", "reportMissingModuleSource", "reportUndefinedVariable"];

export type PyrightConfig = Record<string, string | string[]>;

/** Everything off except the audit rules, as warnings; `root` goes on extraPaths so the project's own imports resolve. */
export function generatePyrightAuditConfig(root: string): PyrightConfig {
  const config: PyrightConfig = { typeCheckingMode: "off", extraPaths: [root] };
  for (const rule of STILL_ON_WHEN_OFF) config[rule] = "none";
  for (const rule of AUDIT_PYRIGHT_RULES) config[rule] = "warning";
  return config;
}
