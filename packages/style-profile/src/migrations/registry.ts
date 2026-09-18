export interface Migration {
  from: string;
  to: string;
  migrate: (profile: Record<string, unknown>) => Record<string, unknown>;
}

const migrations: Migration[] = [];

export function registerMigration(migration: Migration): void {
  migrations.push(migration);
  migrations.sort((a, b) => a.from.localeCompare(b.from));
}

export function getMigrations(): ReadonlyArray<Migration> {
  return migrations;
}

export function clearMigrations(): void {
  migrations.length = 0;
}
