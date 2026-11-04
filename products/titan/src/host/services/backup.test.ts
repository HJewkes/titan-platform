import { describe, expect, it } from "vitest";
import { BACKUP_SERVICE, backupScriptPath, renderBackupService, renderBackupTimer } from "./backup.js";

const lines = (text: string) => text.split("\n");

describe("titan-host-backup.service", () => {
  it("runs the script by absolute path at low CPU and idle IO priority", () => {
    const unit = lines(renderBackupService("/opt/titan/products/titan/scripts/host-backup.sh"));

    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("ExecStart=/bin/bash /opt/titan/products/titan/scripts/host-backup.sh");
    expect(unit).toContain("Nice=10");
    expect(unit).toContain("IOSchedulingClass=idle");
  });

  it("refuses a relative script path, which systemd would resolve against /", () => {
    expect(() => renderBackupService("scripts/host-backup.sh")).toThrow(/absolute/);
  });

  it("finds the script beside the built bin's dist directory", () => {
    expect(backupScriptPath("/opt/titan/products/titan/dist/bin.js")).toBe("/opt/titan/products/titan/scripts/host-backup.sh");
  });
});

describe("titan-host-backup.timer", () => {
  it("fires nightly at 02:30 and catches up a run missed while the host was down", () => {
    const timer = lines(renderBackupTimer());

    expect(timer).toContain("OnCalendar=*-*-* 02:30:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain(`Unit=${BACKUP_SERVICE}`);
    expect(timer).toContain("WantedBy=timers.target");
  });
});
