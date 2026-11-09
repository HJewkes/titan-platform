import { CURRENT_VERSION, runMigrations } from './index.js';
import { readRawSchemaVersion, writeSchemaVersion } from '../schemas/state.js';

/**
 * Ensures the schema version file is present and up to date.
 *
 * - If the file is missing: writes `CURRENT_VERSION` (fresh install).
 * - If the file equals `CURRENT_VERSION`: no-op.
 * - If the file is older than `CURRENT_VERSION`: runs migrations in
 *   order, then writes the new version.
 * - If the file is newer than `CURRENT_VERSION`: throws (downgrade not
 *   supported).
 *
 * The summary is shaped for CLI/MCP startup logs.
 */
export async function ensureSchemaVersion(activeRoot: string): Promise<{
  before: number;
  after: number;
  migrated: boolean;
  ran: Array<{ from: number; to: number; description: string }>;
}> {
  const raw = await readRawSchemaVersion(activeRoot);

  if (!raw.present) {
    await writeSchemaVersion(activeRoot, CURRENT_VERSION);
    return {
      before: CURRENT_VERSION,
      after: CURRENT_VERSION,
      migrated: false,
      ran: [],
    };
  }

  const before = raw.version;

  if (before === CURRENT_VERSION) {
    return { before, after: before, migrated: false, ran: [] };
  }

  const { ran } = await runMigrations(activeRoot, before);
  await writeSchemaVersion(activeRoot, CURRENT_VERSION);

  return {
    before,
    after: CURRENT_VERSION,
    migrated: ran.length > 0,
    ran: ran.map((m) => ({ from: m.from, to: m.to, description: m.description })),
  };
}
