import { describe, expect, it } from "vitest";
import { renderSampleService, renderSampleTimer, sampleUnitDir, stableNodePath } from "./units.js";

const service = (overrides: Partial<Parameters<typeof renderSampleService>[0]> = {}) =>
  renderSampleService({ nodePath: "/opt/node/bin/node", titanBin: "/srv/titan/dist/bin.js", errLog: "/srv/state/titan/health-sample.err.log", ...overrides });

const lines = (text: string) => text.split("\n");

describe("the titan-health-sample timer", () => {
  it("fires on every wall-clock minute without coalescing or catching up", () => {
    const timer = lines(renderSampleTimer());

    expect(timer).toContain("OnCalendar=*-*-* *:*:00");
    expect(timer).toContain("AccuracySec=1s");
    expect(timer).toContain("Persistent=false");
    expect(timer).toContain("Unit=titan-health-sample.service");
    expect(timer).toContain("WantedBy=timers.target");
  });
});

describe("the titan-health-sample service", () => {
  it("is a low-priority oneshot with systemd's CPU and IO accounting on", () => {
    const unit = lines(service());

    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("Nice=10");
    expect(unit).toContain("IOSchedulingClass=idle");
    expect(unit).toContain("CPUAccounting=yes");
    expect(unit).toContain("IOAccounting=yes");
  });

  it("runs the titan bin by absolute path through node, with no PATH lookup", () => {
    const unit = lines(service());

    expect(unit).toContain("ExecStart=/opt/node/bin/node /srv/titan/dist/bin.js health sample");
    expect(unit).toContain("Environment=PATH=/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("lists node's directory once when it is already a system directory", () => {
    expect(lines(service({ nodePath: "/usr/bin/node" }))).toContain("Environment=PATH=/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("appends stderr to the given log and is not installed on its own", () => {
    const text = service();

    expect(lines(text)).toContain("StandardError=append:/srv/state/titan/health-sample.err.log");
    expect(text).not.toContain("[Install]");
  });

  it("quotes a bin path with a space and escapes systemd's specifier and variable characters", () => {
    const unit = lines(service({ titanBin: "/srv/my titan/50%/$HOME/bin.js" }));

    expect(unit).toContain('ExecStart=/opt/node/bin/node "/srv/my titan/50%%/$$HOME/bin.js" health sample');
  });
});

describe("sampleUnitDir", () => {
  it("uses XDG_CONFIG_HOME when it is absolute and ignores a relative one", () => {
    expect(sampleUnitDir({ env: { XDG_CONFIG_HOME: "/srv/cfg" }, home: "/srv/me" })).toBe("/srv/cfg/systemd/user");
    expect(sampleUnitDir({ env: { XDG_CONFIG_HOME: "cfg" }, home: "/srv/me" })).toBe("/srv/me/.config/systemd/user");
    expect(sampleUnitDir({ env: {}, home: "/srv/me" })).toBe("/srv/me/.config/systemd/user");
  });
});

describe("stableNodePath", () => {
  const cellar = "/opt/homebrew/Cellar/node/24.1.0/bin/node";

  it("prefers the Homebrew prefix symlink that resolves to the same node", () => {
    const probe = { exists: () => true, realpath: () => cellar };

    expect(stableNodePath(cellar, probe)).toBe("/opt/homebrew/bin/node");
  });

  it("keeps the Cellar path when the symlink points at another version", () => {
    const probe = { exists: () => true, realpath: (path: string) => (path === cellar ? cellar : "/elsewhere/node") };

    expect(stableNodePath(cellar, probe)).toBe(cellar);
  });

  it("leaves a non-Homebrew node alone", () => {
    expect(stableNodePath("/usr/bin/node")).toBe("/usr/bin/node");
  });
});
