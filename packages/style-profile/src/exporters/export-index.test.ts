import { describe, it, expect } from "vitest";
import { exportProfile } from "./export-index.js";
import type { Profile } from "../schema/profile.js";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
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
    ...overrides,
  };
}

describe("exportProfile", () => {
  it("dispatches to eslint exporter", () => {
    const files = exportProfile(makeProfile(), "eslint");
    expect(files.some((f) => f.path === "eslint.config.js")).toBe(true);
  });

  it("dispatches to ruff exporter", () => {
    const files = exportProfile(makeProfile(), "ruff");
    expect(files.some((f) => f.path === "ruff.toml")).toBe(true);
  });

  it("dispatches to markdown exporter", () => {
    const files = exportProfile(makeProfile(), "markdown");
    expect(files.some((f) => f.path.endsWith(".md"))).toBe(true);
  });

  it("dispatches to editorconfig exporter", () => {
    const files = exportProfile(makeProfile(), "editorconfig");
    expect(files.some((f) => f.path === ".editorconfig")).toBe(true);
  });

  it("dispatches to hooks exporter", () => {
    const files = exportProfile(makeProfile(), "hooks");
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]?.path).toBe(".claude/settings.json");
  });

  it("dispatches to claude-rules exporter", () => {
    const files = exportProfile(makeProfile(), "claude-rules");
    expect(files.some((f) => f.path.includes(".claude/rules/"))).toBe(true);
  });

  it("throws for unknown format", () => {
    expect(() =>
      exportProfile(makeProfile(), "unknown" as never),
    ).toThrow(/unsupported export format/i);
  });

  it("returns non-empty content for non-template formats", () => {
    const profile = makeProfile();
    for (const format of [
      "eslint",
      "ruff",
      "markdown",
      "editorconfig",
      "hooks",
      "claude-rules",
    ] as const) {
      const files = exportProfile(profile, format);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(file.content.length).toBeGreaterThan(0);
      }
    }
  });
});
