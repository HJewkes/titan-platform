import { dirname, isAbsolute, join } from "node:path";
import { renderCalendarTimer, renderOneshotService } from "../../systemd/render.js";

export const BACKUP_SERVICE = "titan-host-backup.service";

/** The built bin is `dist/bin.js`; the script ships beside `dist/` in the same checkout. */
export const backupScriptPath = (titanBin: string): string => join(dirname(titanBin), "..", "scripts", "host-backup.sh");

/**
 * systemd runs the unit from no working directory, so a relative script path would resolve
 * against `/`. Nice and idle IO keep restic out of the way of anything interactive.
 */
export function renderBackupService(scriptPath: string): string {
  if (!isAbsolute(scriptPath)) throw new Error(`backup script path must be absolute: ${scriptPath}`);
  return renderOneshotService({
    description: "titan host nightly restic backup",
    argv: ["/bin/bash", scriptPath],
    nice: 10,
    idleIo: true,
  });
}

/** Persistent=true runs a backup missed while the host was down as soon as it is back. */
export function renderBackupTimer(): string {
  return renderCalendarTimer({
    description: "titan host nightly restic backup at 02:30",
    onCalendar: "*-*-* 02:30:00",
    persistent: true,
    unit: BACKUP_SERVICE,
  });
}
