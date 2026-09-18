import { describe, it, expect } from "vitest";
import { generateHooksConfig } from "./hooks.js";
import type { Profile } from "../schema/profile.js";

const sampleProfile: Profile = {
  schemaVersion: "1.0.0",
  author: "testuser",
  generated: "2026-02-27",
  sources: [],
  naming: {
    variables: {
      convention: "camelCase",
      confidence: 0.94,
      stability: "high",
    },
  },
  structure: {},
  documentation: {},
  errorHandling: {},
  formatting: {},
  patterns: {},
  idioms: { detected: [] },
  antiPatterns: { acknowledged: [] },
  overrides: [],
  severityThresholds: { error: 0.85, warn: 0.60, info: 0.40 },
};

describe("generateHooksConfig", () => {
  it("returns a settings object with hooks array", () => {
    const config = generateHooksConfig(sampleProfile);
    expect(config.hooks).toBeDefined();
    expect(Array.isArray(config.hooks)).toBe(true);
  });

  it("includes a PostToolUse hook for file_write", () => {
    const config = generateHooksConfig(sampleProfile);
    const writeHook = config.hooks.find(
      (h) => h.event === "PostToolUse" && h.matcher === "Write",
    );
    expect(writeHook).toBeDefined();
  });

  it("hook command runs codewatch diff on the written file", () => {
    const config = generateHooksConfig(sampleProfile);
    const writeHook = config.hooks.find((h) => h.event === "PostToolUse")!;
    expect(writeHook.command).toContain("codewatch");
    expect(writeHook.command).toContain("diff");
  });

  it("includes a PostToolUse hook for Edit tool", () => {
    const config = generateHooksConfig(sampleProfile);
    const editHook = config.hooks.find(
      (h) => h.event === "PostToolUse" && h.matcher === "Edit",
    );
    expect(editHook).toBeDefined();
  });
});
