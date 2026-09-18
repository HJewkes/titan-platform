import { describe, it, expect } from "vitest";
import { generateSkillFiles } from "./skill.js";
import type { Profile } from "../schema/profile.js";

const sampleProfile: Profile = {
  schemaVersion: "1.0.0",
  author: "testuser",
  generated: "2026-02-27",
  sources: ["testuser/repo-a"],
  naming: {
    variables: {
      convention: "camelCase",
      confidence: 0.94,
      stability: "high",
      description: "Use camelCase for all local variables and parameters.",
      examples: [
        { good: "const userProfile = await fetchUser(id);" },
      ],
    },
    functions: { convention: "camelCase", confidence: 0.97, stability: "high" },
    types: { convention: "PascalCase", confidence: 0.99, stability: "high" },
  },
  structure: {
    importOrder: {
      convention: ["builtin", "external", "internal", "relative"],
      confidence: 0.91,
      fixability: "safe",
      description:
        "Group imports: Node builtins, then external packages, then internal aliases, then relative paths.",
    },
    preferredPatterns: {
      convention: ["guard-clauses", "early-return", "composition"],
      confidence: 0.82,
    },
  },
  documentation: {
    functionDocs: {
      convention: "jsdoc-selective",
      confidence: 0.80,
      description:
        "Add JSDoc to exported functions only. Rely on TypeScript types instead of @param tags.",
    },
  },
  errorHandling: {},
  formatting: {},
  patterns: {
    preferPureFunctions: {
      convention: "strong",
      confidence: 0.82,
      stability: "medium",
    },
    avoidClassInheritance: {
      convention: "moderate",
      confidence: 0.68,
      stability: "medium",
    },
  },
  idioms: { detected: [] },
  antiPatterns: { acknowledged: [] },
  overrides: [],
  severityThresholds: { error: 0.85, warn: 0.60, info: 0.40 },
};

describe("generateSkillFiles", () => {
  it("returns a skill.md file", () => {
    const files = generateSkillFiles(sampleProfile);
    const skillMd = files.find((f) => f.path.endsWith("skill.md"));
    expect(skillMd).toBeDefined();
  });

  it("skill.md contains tiered rule sections", () => {
    const files = generateSkillFiles(sampleProfile);
    const skillMd = files.find((f) => f.path.endsWith("skill.md"))!;
    expect(skillMd.content).toContain("## Critical Rules (always follow)");
    expect(skillMd.content).toContain("camelCase");
    expect(skillMd.content).toContain("PascalCase");
  });

  it("skill.md references detail docs", () => {
    const files = generateSkillFiles(sampleProfile);
    const skillMd = files.find((f) => f.path.endsWith("skill.md"))!;
    expect(skillMd.content).toContain("references/");
  });

  it("generates naming.md reference doc", () => {
    const files = generateSkillFiles(sampleProfile);
    const namingMd = files.find((f) => f.path.endsWith("naming.md"));
    expect(namingMd).toBeDefined();
    expect(namingMd!.content).toContain("camelCase");
  });

  it("generates patterns.md reference doc", () => {
    const files = generateSkillFiles(sampleProfile);
    const patternsMd = files.find((f) => f.path.endsWith("patterns.md"));
    expect(patternsMd).toBeDefined();
    expect(patternsMd!.content).toContain("guard-clauses");
  });

  it("includes examples when available", () => {
    const files = generateSkillFiles(sampleProfile);
    const namingMd = files.find((f) => f.path.endsWith("naming.md"));
    expect(namingMd).toBeDefined();
    expect(namingMd!.content).toContain("userProfile");
  });

  it("skill.md is concise (under 3000 chars)", () => {
    const files = generateSkillFiles(sampleProfile);
    const skillMd = files.find((f) => f.path.endsWith("skill.md"))!;
    expect(skillMd.content.length).toBeLessThan(3000);
  });

  it("renders readable descriptions for boolean conventions", () => {
    const profileWithBool: Profile = {
      ...sampleProfile,
      formatting: {
        semicolons: {
          convention: true,
          confidence: 0.97,
          stability: "high",
          description: "Always use semicolons",
        },
      },
    };
    const files = generateSkillFiles(profileWithBool);
    const skillMd = files.find((f) => f.path.endsWith("skill.md"))!;
    expect(skillMd.content).toContain("Always use semicolons");
    expect(skillMd.content).not.toContain(": true (");
  });

  it("skill.md includes strong conventions tier", () => {
    const files = generateSkillFiles(sampleProfile);
    const skillMd = files.find((f) => f.path.endsWith("skill.md"))!;
    expect(skillMd.content).toContain("## Strong Conventions");
  });

  it("per-language template groups rules by tier", () => {
    const files = generateSkillFiles(sampleProfile);
    const langMd = files.find((f) =>
      f.path.includes("per-language/typescript.md"),
    )!;
    expect(langMd.content).toContain("## Critical Rules");
  });
});
