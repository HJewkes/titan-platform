import { describe, it, expect } from "vitest";
import { generateRuffConfig } from "./ruff.js";
import type { Profile } from "@titan-design/style-profile";

const baseProfile: Profile = {
  schemaVersion: "1.0.0",
  author: "testuser",
  generated: "2026-02-27",
  sources: [],
  naming: {},
  structure: {},
  documentation: {},
  errorHandling: {},
  formatting: {},
  patterns: {},
  idioms: { detected: [] },
  antiPatterns: { acknowledged: [] },
  overrides: [],
  severityThresholds: { error: 0.85, warn: 0.6, info: 0.4 },
};

const sampleProfile: Profile = {
  ...baseProfile,
  naming: {
    variables: {
      convention: "snake_case",
      confidence: 0.92,
      stability: "high",
      extensions: { ruff: { codes: ["N806"] } },
    },
  },
  structure: {
    importOrder: {
      convention: ["builtin", "external", "internal", "relative"],
      confidence: 0.91,
      fixability: "safe",
    },
    functionMaxLines: {
      convention: 30,
      confidence: 0.78,
    },
  },
  documentation: {
    functionDocs: {
      convention: "google",
      confidence: 0.85,
    },
  },
};

describe("generateRuffConfig", () => {
  it("returns a ruff config object", () => {
    const config = generateRuffConfig(sampleProfile);
    expect(config).toBeDefined();
    expect(typeof config).toBe("object");
  });

  it("includes N rules for naming conventions", () => {
    const config = generateRuffConfig(sampleProfile);
    expect(config.lint?.select).toContain("N");
  });

  it("includes I rules for import ordering", () => {
    const config = generateRuffConfig(sampleProfile);
    expect(config.lint?.select).toContain("I");
  });

  it("includes D rules for docstring conventions", () => {
    const config = generateRuffConfig(sampleProfile);
    expect(config.lint?.select).toContain("D");
  });

  it("includes C90 for complexity when functionMaxLines is set", () => {
    const config = generateRuffConfig(sampleProfile);
    expect(config.lint?.select).toContain("C90");
  });

  it("sets max-complexity from functionMaxLines convention", () => {
    const config = generateRuffConfig(sampleProfile);
    expect(config.lint?.mccabe?.["max-complexity"]).toBeDefined();
  });

  it("sets docstring convention", () => {
    const config = generateRuffConfig(sampleProfile);
    expect(config.lint?.pydocstyle?.convention).toBe("google");
  });

  it("serializes to valid TOML structure", () => {
    const config = generateRuffConfig(sampleProfile);
    expect(config.lint).toBeDefined();
    expect(Array.isArray(config.lint?.select)).toBe(true);
  });
});
