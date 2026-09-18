import type { Profile } from "@titan-design/style-profile";

export interface RuffConfig {
  lint?: {
    select?: string[];
    ignore?: string[];
    fixable?: string[];
    "per-file-ignores"?: Record<string, string[]>;
    mccabe?: { "max-complexity"?: number };
    pydocstyle?: { convention?: string };
    isort?: {
      "known-first-party"?: string[];
      "section-order"?: string[];
    };
  };
  "line-length"?: number;
}

export function generateRuffConfig(profile: Profile): RuffConfig {
  const select: string[] = [];
  const config: RuffConfig = { lint: { select } };

  if (profile.naming) {
    const hasNamingRules = Object.values(profile.naming).some(
      (rule) => rule.confidence >= profile.severityThresholds.info,
    );
    if (hasNamingRules) select.push("N");
  }

  const importOrder = profile.structure?.importOrder;
  if (importOrder && importOrder.confidence >= profile.severityThresholds.info) {
    select.push("I");
    if (Array.isArray(importOrder.convention)) {
      config.lint!.isort = {
        "section-order": importOrder.convention as string[],
      };
    }
  }

  const functionDocs = profile.documentation?.functionDocs;
  if (functionDocs && functionDocs.confidence >= profile.severityThresholds.info) {
    select.push("D");
    const conv = functionDocs.convention;
    if (
      typeof conv === "string" &&
      conv !== "jsdoc-selective" &&
      conv !== "jsdoc-all"
    ) {
      config.lint!.pydocstyle = { convention: conv };
    }
  }

  const maxLines = profile.structure?.functionMaxLines;
  if (
    maxLines &&
    maxLines.confidence >= profile.severityThresholds.info &&
    typeof maxLines.convention === "number"
  ) {
    select.push("C90");
    config.lint!.mccabe = { "max-complexity": maxLines.convention };
  }

  const lineLength = profile.formatting?.lineLength;
  if (lineLength && typeof lineLength.convention === "number") {
    config["line-length"] = lineLength.convention;
  }

  return config;
}
