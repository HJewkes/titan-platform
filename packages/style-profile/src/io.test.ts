import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readProfile, writeProfile, validateProfile } from "./io.js";
import { SCHEMA_VERSION, DEFAULT_SEVERITY_THRESHOLDS } from "./schema/profile.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";

describe("Profile I/O", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `codewatch-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const minimalProfile = {
    schemaVersion: SCHEMA_VERSION,
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
  };

  it("round-trips a profile through write and read", async () => {
    const filePath = path.join(testDir, "profile.json");

    await writeProfile(filePath, minimalProfile);
    const loaded = await readProfile(filePath);

    expect(loaded.schemaVersion).toBe(SCHEMA_VERSION);
    expect(loaded.author).toBe("testuser");
    expect(loaded.severityThresholds).toEqual(DEFAULT_SEVERITY_THRESHOLDS);
  });

  it("throws on invalid profile JSON", async () => {
    const filePath = path.join(testDir, "profile.json");
    await fs.writeFile(filePath, '{"invalid": true}');

    await expect(readProfile(filePath)).rejects.toThrow();
  });

  it("validateProfile returns errors for invalid data", () => {
    const result = validateProfile({ bad: "data" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it("validateProfile returns parsed data for valid input", () => {
    const result = validateProfile(minimalProfile);
    expect(result.success).toBe(true);
  });
});
