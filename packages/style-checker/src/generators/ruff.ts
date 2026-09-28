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
  preview?: boolean;
}

type RuffLint = NonNullable<RuffConfig["lint"]> & { select: string[] };

function addNaming(profile: Profile, lint: RuffLint): void {
  if (profile.naming) {
    const hasNamingRules = Object.values(profile.naming).some(
      (rule) => rule.confidence >= profile.severityThresholds.info,
    );
    if (hasNamingRules) lint.select.push("N");
  }
}

function addImportOrder(profile: Profile, lint: RuffLint): void {
  const importOrder = profile.structure?.importOrder;
  if (importOrder && importOrder.confidence >= profile.severityThresholds.info) {
    lint.select.push("I");
    if (Array.isArray(importOrder.convention)) {
      lint.isort = {
        "section-order": importOrder.convention as string[],
      };
    }
  }
}

function addFunctionDocs(profile: Profile, lint: RuffLint): void {
  const functionDocs = profile.documentation?.functionDocs;
  if (functionDocs && functionDocs.confidence >= profile.severityThresholds.info) {
    lint.select.push("D");
    const conv = functionDocs.convention;
    if (
      typeof conv === "string" &&
      conv !== "jsdoc-selective" &&
      conv !== "jsdoc-all"
    ) {
      lint.pydocstyle = { convention: conv };
    }
  }
}

function addComplexity(profile: Profile, lint: RuffLint): void {
  const maxLines = profile.structure?.functionMaxLines;
  if (
    maxLines &&
    maxLines.confidence >= profile.severityThresholds.info &&
    typeof maxLines.convention === "number"
  ) {
    lint.select.push("C90");
    lint.mccabe = { "max-complexity": maxLines.convention };
  }
}

export function generateRuffConfig(profile: Profile): RuffConfig {
  const lint: RuffLint = { select: [] };
  const config: RuffConfig = { lint };

  addNaming(profile, lint);
  addImportOrder(profile, lint);
  addFunctionDocs(profile, lint);
  addComplexity(profile, lint);

  const lineLength = profile.formatting?.lineLength;
  if (lineLength && typeof lineLength.convention === "number") {
    config["line-length"] = lineLength.convention;
  }

  return config;
}
