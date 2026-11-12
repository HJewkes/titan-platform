import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const unit = (name) => readFileSync(join(REPO, "ops", "systemd", name), "utf8");
const line = (text, key) => text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];

describe("ticket-scorecard units", () => {
  it("structure test: unit names a dist bin that exists", () => {
    const execStart = line(unit("ticket-scorecard.service"), "ExecStart");
    const bin = execStart?.match(/\s(%h\/projects\/titan-platform\/\S+\/dist\/bin\.js)\s/)?.[1];

    expect(bin).toBeDefined();
    expect(existsSync(join(REPO, bin.replace("%h/projects/titan-platform/", "")))).toBe(true);
  });

  it("runs the scorecard job as an idle-priority oneshot that finds titan-factory on its PATH", () => {
    const service = unit("ticket-scorecard.service");

    expect(line(service, "Type")).toBe("oneshot");
    expect(line(service, "ExecStart")).toMatch(/ ticket-scorecard run$/);
    expect(line(service, "Environment")).toMatch(/^"PATH=%h\/\.local\/bin:/);
    expect(line(service, "SuccessExitStatus")).toBe("75");
    expect(line(service, "IOSchedulingClass")).toBe("idle");
  });

  it("keeps a timeout and a persistent calendar before each digest slot", () => {
    expect(line(unit("ticket-scorecard.service"), "TimeoutStartSec")).toBe("20min");
    const timer = unit("ticket-scorecard.timer");
    expect(line(timer, "OnCalendar")).toBe("*-*-* 05,11,17:45:00 America/Denver");
    expect(line(timer, "Persistent")).toBe("true");
  });

  it("names no operator path", () => {
    for (const name of ["ticket-scorecard.service", "ticket-scorecard.timer"]) {
      expect(unit(name)).not.toMatch(new RegExp(`/(${["Users", "home"].join("|")})/`));
    }
  });
});
