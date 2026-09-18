import { describe, it, expect } from "vitest";
import { generateEditorConfigExport } from "./editorconfig.js";
import type { Profile } from "../schema/profile.js";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
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
    severityThresholds: { error: 0.85, warn: 0.60, info: 0.40 },
    ...overrides,
  };
}

describe("generateEditorConfigExport", () => {
  it("returns a file with .editorconfig path", () => {
    const file = generateEditorConfigExport(makeProfile());
    expect(file.path).toBe(".editorconfig");
  });

  it("includes root = true", () => {
    const file = generateEditorConfigExport(makeProfile());
    expect(file.content).toContain("root = true");
  });

  it("includes indent_style", () => {
    const profile = makeProfile({
      formatting: {
        indentStyle: { convention: "spaces", confidence: 0.99, stability: "high" },
      },
    });
    const file = generateEditorConfigExport(profile);
    expect(file.content).toContain("indent_style = space");
  });

  it("includes indent_size", () => {
    const profile = makeProfile({
      formatting: {
        indentSize: { convention: 2, confidence: 0.99, stability: "high" },
      },
    });
    const file = generateEditorConfigExport(profile);
    expect(file.content).toContain("indent_size = 2");
  });

  it("includes insert_final_newline", () => {
    const profile = makeProfile({
      formatting: {
        trailingNewline: { convention: true, confidence: 0.95, stability: "high" },
      },
    });
    const file = generateEditorConfigExport(profile);
    expect(file.content).toContain("insert_final_newline = true");
  });

  it("includes max_line_length", () => {
    const profile = makeProfile({
      formatting: {
        lineLength: { convention: 100, confidence: 0.85, stability: "medium" },
      },
    });
    const file = generateEditorConfigExport(profile);
    expect(file.content).toContain("max_line_length = 100");
  });

  it("handles empty formatting section gracefully", () => {
    const file = generateEditorConfigExport(makeProfile());
    expect(file.content).toContain("root = true");
    expect(file.content).toContain("[*]");
  });

  it("includes default encoding and line ending settings", () => {
    const file = generateEditorConfigExport(makeProfile());
    expect(file.content).toContain("end_of_line = lf");
    expect(file.content).toContain("charset = utf-8");
    expect(file.content).toContain("trim_trailing_whitespace = true");
  });
});
