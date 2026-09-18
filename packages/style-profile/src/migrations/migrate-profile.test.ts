import { describe, it, expect, beforeEach } from "vitest";
import { migrateProfile, registerMigration, clearMigrations } from "./migrate-profile.js";

describe("Migration framework", () => {
  beforeEach(() => {
    clearMigrations();
  });

  it("returns profile unchanged when already at current version", () => {
    const profile = { schemaVersion: "1.0.0", data: "test" };
    const result = migrateProfile(profile);
    expect(result.schemaVersion).toBe("1.0.0");
  });

  it("applies migrations in order", () => {
    registerMigration({
      from: "0.9.0",
      to: "1.0.0",
      migrate: (p) => ({ ...p, schemaVersion: "1.0.0", migrated: true }),
    });

    const profile = { schemaVersion: "0.9.0" };
    const result = migrateProfile(profile);
    expect(result.schemaVersion).toBe("1.0.0");
    expect(result.migrated).toBe(true);
  });

  it("throws for unknown schema version with no migration path", () => {
    const profile = { schemaVersion: "0.1.0" };
    expect(() => migrateProfile(profile)).toThrow();
  });
});
