import { describe, expect, it } from "vitest";
import { generateRuffAuditConfig } from "./ruff-audit.js";

describe("generateRuffAuditConfig", () => {
  it("selects exactly the pinned audit rules with preview on", () => {
    const config = generateRuffAuditConfig();

    expect(config.lint?.select).toEqual([
      "C901", "PLR0904", "PLR0911", "PLR0912", "PLR0913", "PLR0914", "PLR0915", "PLR0916", "PLR0917",
      "PLR1702", "ARG", "FBT", "ERA001", "BLE001", "S110", "TRY203", "SIM105", "F401", "F841", "PIE790",
      "RUF100",
    ]);
    expect(config.preview).toBe(true);
  });

  it("returns a fresh select list, so a caller's edit cannot change the pinned set", () => {
    generateRuffAuditConfig().lint?.select?.push("E501");

    expect(generateRuffAuditConfig().lint?.select).not.toContain("E501");
  });
});
