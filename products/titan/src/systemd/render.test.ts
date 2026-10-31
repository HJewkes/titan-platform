import { describe, expect, it } from "vitest";
import { renderCalendarTimer, renderOneshotService } from "./render.js";

const lines = (text: string) => text.split("\n");

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

describe("renderOneshotService over awkward values", () => {
  it("renders spaces, quotes, percent, dollar, unicode and empty values exactly as before the helpers moved", () => {
    const text = renderOneshotService({
      description: "100% é",
      argv: ["/bin/x", "a b", 'q"r', "it's", "50%/$HOME", "caf\u00e9 \u2603", ""],
      environment: { A: "x y", B: "", C: "%h" },
      environmentFile: "/srv/%i.env",
      errLog: "/srv/e %n.log",
    });

    expect(text).toBe(
      [
        "[Unit]",
        "Description=100%% é",
        "",
        "[Service]",
        "Type=oneshot",
        'ExecStart=/bin/x "a b" "q\\"r" "it\'s" 50%%/$$HOME "café ☃" ',
        'Environment="A=x y"',
        "Environment=B=",
        "Environment=C=%%h",
        "EnvironmentFile=/srv/%%i.env",
        "StandardError=append:/srv/e %%n.log",
        "",
      ].join("\n"),
    );
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
