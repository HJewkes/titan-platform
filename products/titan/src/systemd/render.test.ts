import { describe, expect, it } from "vitest";
import { execArg, quoteIfNeeded, renderCalendarTimer, renderOneshotService, userUnitDir } from "./render.js";

const lines = (text: string) => text.split("\n");

describe("systemd value quoting", () => {
  it("doubles a literal specifier and variable sign in an ExecStart argument", () => {
    expect(execArg("50%/$HOME")).toBe("50%%/$$HOME");
  });

  it("double-quotes a value with whitespace and escapes its quotes and backslashes", () => {
    expect(quoteIfNeeded('/srv/my dir/a"b\\c')).toBe('"/srv/my dir/a\\"b\\\\c"');
  });

  it("leaves a plain path unquoted", () => {
    expect(quoteIfNeeded("/usr/bin/restic")).toBe("/usr/bin/restic");
  });
});

describe("renderOneshotService", () => {
  it("emits only the lines whose options are set and no [Install] section", () => {
    const text = renderOneshotService({ description: "backup", argv: ["/bin/bash", "/srv/run.sh"] });

    expect(text).toBe(["[Unit]", "Description=backup", "", "[Service]", "Type=oneshot", "ExecStart=/bin/bash /srv/run.sh", ""].join("\n"));
  });

  it("quotes environment values and escapes specifiers in the environment file and error log", () => {
    const unit = lines(
      renderOneshotService({
        description: "backup at 100%",
        argv: ["/bin/bash", "/srv/my scripts/run.sh"],
        nice: 10,
        idleIo: true,
        environment: { BACKUP_PATHS: "/a /b" },
        environmentFile: "/srv/%i.env",
        errLog: "/srv/state/run.err.log",
      }),
    );

    expect(unit).toContain("Description=backup at 100%%");
    expect(unit).toContain('ExecStart=/bin/bash "/srv/my scripts/run.sh"');
    expect(unit).toContain("Nice=10");
    expect(unit).toContain("IOSchedulingClass=idle");
    expect(unit).toContain('Environment="BACKUP_PATHS=/a /b"');
    expect(unit).toContain("EnvironmentFile=/srv/%%i.env");
    expect(unit).toContain("StandardError=append:/srv/state/run.err.log");
  });
});

describe("renderCalendarTimer", () => {
  it("names its calendar, catch-up policy and unit, and installs under timers.target", () => {
    const timer = lines(renderCalendarTimer({ description: "nightly", onCalendar: "*-*-* 02:30:00", persistent: true, unit: "x.service" }));

    expect(timer).toContain("OnCalendar=*-*-* 02:30:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=x.service");
    expect(timer).toContain("WantedBy=timers.target");
    expect(timer.some((entry) => entry.startsWith("AccuracySec="))).toBe(false);
  });
});

describe("userUnitDir", () => {
  it("uses XDG_CONFIG_HOME when it is absolute and ignores a relative one", () => {
    expect(userUnitDir({ env: { XDG_CONFIG_HOME: "/srv/cfg" }, home: "/srv/me" })).toBe("/srv/cfg/systemd/user");
    expect(userUnitDir({ env: { XDG_CONFIG_HOME: "cfg" }, home: "/srv/me" })).toBe("/srv/me/.config/systemd/user");
  });
});
