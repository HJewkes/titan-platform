import type { RuffConfig } from "./ruff.js";

/** The audit's pinned ruff selection: complexity, size, dead code, and defensive-bloat signals. */
export const AUDIT_RUFF_RULES: readonly string[] = [
  "C901",
  "PLR0904",
  "PLR0911",
  "PLR0912",
  "PLR0913",
  "PLR0914",
  "PLR0915",
  "PLR0916",
  "PLR0917",
  "PLR1702",
  "ARG",
  "FBT",
  "ERA001",
  "BLE001",
  "S110",
  "TRY203",
  "SIM105",
  "F401",
  "F841",
  "PIE790",
  "RUF100",
];

/** Preview is on because ruff 0.16.8 silently skips PLR0904, PLR0914, PLR0916 and PLR1702 without it. */
export function generateRuffAuditConfig(): RuffConfig {
  return { preview: true, lint: { select: [...AUDIT_RUFF_RULES] } };
}
