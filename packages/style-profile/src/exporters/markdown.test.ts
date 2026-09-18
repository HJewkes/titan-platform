import { describe, it, expect } from "vitest";
import { generateMarkdownExport } from "./markdown.js";
import type { Profile } from "../schema/profile.js";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    schemaVersion: "1.0.0",
    author: "testuser",
    generated: "2026-02-27",
    sources: ["testuser/repo-a"],
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

describe("generateMarkdownExport", () => {
  it("returns a file with .md extension", () => {
    const file = generateMarkdownExport(makeProfile());
    expect(file.path).toMatch(/\.md$/);
  });

  it("includes a title with author name", () => {
    const file = generateMarkdownExport(makeProfile());
    expect(file.content).toContain("testuser");
    expect(file.content).toContain("# ");
  });

  it("organizes rules by category with headings", () => {
    const profile = makeProfile({
      naming: {
        variables: { convention: "camelCase", confidence: 0.94, stability: "high" },
      },
      structure: {
        importOrder: {
          convention: ["builtin", "external", "internal", "relative"],
          confidence: 0.91,
        },
      },
      formatting: {
        semicolons: { convention: true, confidence: 0.99, stability: "high" },
      },
    });
    const file = generateMarkdownExport(profile);
    expect(file.content).toContain("## Naming");
    expect(file.content).toContain("## Structure");
    expect(file.content).toContain("## Formatting");
  });

  it("includes rule conventions", () => {
    const profile = makeProfile({
      naming: {
        variables: { convention: "camelCase", confidence: 0.94, stability: "high" },
        types: { convention: "PascalCase", confidence: 0.99, stability: "high" },
      },
    });
    const file = generateMarkdownExport(profile);
    expect(file.content).toContain("camelCase");
    expect(file.content).toContain("PascalCase");
  });

  it("includes examples when available", () => {
    const profile = makeProfile({
      naming: {
        variables: {
          convention: "camelCase",
          confidence: 0.94,
          stability: "high",
          description: "Use camelCase for all local variables.",
          examples: [
            { good: "const userProfile = await fetchUser(id);" },
            { bad: "const up = await fetchUser(id);" },
          ],
        },
      },
    });
    const file = generateMarkdownExport(profile);
    expect(file.content).toContain("userProfile");
  });

  it("shows confidence percentages", () => {
    const profile = makeProfile({
      naming: {
        variables: { convention: "camelCase", confidence: 0.94, stability: "high" },
      },
    });
    const file = generateMarkdownExport(profile);
    expect(file.content).toContain("94%");
  });

  it("shows sources in header", () => {
    const file = generateMarkdownExport(makeProfile());
    expect(file.content).toContain("testuser/repo-a");
  });
});
