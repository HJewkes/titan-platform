import { SCHEMA_VERSION } from "../schema/profile.js";
import { getMigrations, registerMigration, clearMigrations } from "./registry.js";

export { registerMigration, clearMigrations };

export function migrateProfile(
  profile: Record<string, unknown>,
): Record<string, unknown> {
  let current = { ...profile };
  const version = current.schemaVersion as string;

  if (version === SCHEMA_VERSION) {
    return current;
  }

  const migrations = getMigrations();
  let currentVersion = version;

  for (const migration of migrations) {
    if (migration.from === currentVersion) {
      current = migration.migrate(current);
      currentVersion = migration.to;
    }
  }

  if (currentVersion !== SCHEMA_VERSION) {
    throw new Error(
      `No migration path from version ${version} to ${SCHEMA_VERSION}`,
    );
  }

  return current;
}
