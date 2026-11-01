import { describe, expect, it } from "vitest";
import type { HostPorts } from "../ports.js";
import { planServices } from "./catalog.js";

function ports(present: string[] = []): HostPorts {
  return {
    exec: async () => {
      throw new Error("planServices must run nothing");
    },
    readFile: async () => {
      throw new Error("planServices must read nothing");
    },
    stat: async (path) => (present.includes(path) ? "file" : null),
    list: async () => [],
    which: async () => null,
  };
}

const paths = { home: "/h", titanBin: "/opt/titan/products/titan/dist/bin.js" };
const UNIT_DIR = "/h/.config/systemd/user";

async function rows(platform: NodeJS.Platform, present: string[] = []) {
  const plan = await planServices(platform, ports(present), paths);
  return Object.fromEntries(plan.services.map((row) => [row.id, row]));
}

describe("the linux service catalog", () => {
  it("renders the backup, delegates health and usage, and defers the memory sampler", async () => {
    const byId = await rows("linux");

    expect(Object.keys(byId)).toEqual(["backup", "health-sampler", "usage-refresh", "memory-sampler"]);
    expect(byId.backup?.source).toBe("render");
    expect(byId["health-sampler"]).toMatchObject({ source: "delegate", commands: ["titan health install"] });
    expect(byId["usage-refresh"]?.source).toBe("delegate");
    expect(byId["usage-refresh"]?.commands?.join("\n")).toContain("@titan-design/anthropic-account");
    expect(byId["memory-sampler"]).toMatchObject({ source: "deferred", task: "TP-792" });
  });

  it("renders both backup units into the user unit dir, running the script beside the bin", async () => {
    const backup = (await rows("linux")).backup;

    expect(backup?.units?.map((unit) => unit.path)).toEqual([
      `${UNIT_DIR}/titan-host-backup.service`,
      `${UNIT_DIR}/titan-host-backup.timer`,
    ]);
    expect(backup?.units?.[0]?.text).toContain("ExecStart=/bin/bash /opt/titan/products/titan/scripts/host-backup.sh");
    expect(backup?.legacyFound).toEqual([]);
  });

  it("names the legacy restic-nightly timer and disables it first when stat finds it", async () => {
    const backup = (await rows("linux", [`${UNIT_DIR}/restic-nightly.timer`])).backup;

    expect(backup?.legacyFound).toEqual(["restic-nightly.timer"]);
    expect(backup?.commands?.[0]).toBe("systemctl --user disable --now restic-nightly.timer");
    expect(backup?.commands?.at(-1)).toBe("systemctl --user enable --now titan-host-backup.timer");
  });
});

describe("the darwin service catalog", () => {
  it("renders nothing, so no plist is ever produced, and names each job's owner", async () => {
    const byId = await rows("darwin");

    expect(Object.values(byId).some((row) => row.source === "render" || row.units !== undefined)).toBe(false);
    expect(byId.backup).toMatchObject({ source: "deferred", task: "TP-1558" });
    expect(byId["health-sampler"]).toMatchObject({ source: "deferred", task: "TP-1659" });
    expect(byId["usage-refresh"]?.source).toBe("chezmoi");
    expect(byId["memory-sampler"]).toMatchObject({ source: "deferred", task: "TP-792" });
  });
});

describe("an uncatalogued platform", () => {
  it("plans no jobs", async () => {
    expect((await planServices("win32", ports(), paths)).services).toEqual([]);
  });
});
