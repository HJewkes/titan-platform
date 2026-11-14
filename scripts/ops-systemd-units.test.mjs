import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const unit = (name) => readFileSync(join(REPO, "ops", "systemd", name), "utf8");
const line = (text, key) => text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];

describe("titan-dispatch-shadow units", () => {
  const service = () => unit("titan-dispatch-shadow.service");
  const timer = () => unit("titan-dispatch-shadow.timer");

  it("runs only the shadow tick, with no path or flag after the verb", () => {
    expect(line(service(), "ExecStart")).toMatch(/ dispatch shadow-tick$/);
  });

  it("is a five-minute oneshot that treats the busy code 75 as success and reads the env file", () => {
    expect(line(service(), "Type")).toBe("oneshot");
    expect(line(service(), "TimeoutStartSec")).toBe("5min");
    expect(line(service(), "SuccessExitStatus")).toBe("75");
    expect(line(service(), "EnvironmentFile")).toBeDefined();
  });

  it("fires at :07 and :37 and does not replay missed ticks", () => {
    expect(line(timer(), "OnCalendar")).toBe("*:07,37");
    expect(line(timer(), "Persistent")).toBe("false");
  });

  it("carries no apply flag, spawn verb or spaced operator path", () => {
    for (const text of [service(), timer()]) {
      expect(text).not.toContain("--apply");
      expect(text).not.toContain("spawn");
      expect(text).not.toContain("Application Support");
    }
  });
});

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
