import { describe, expect, it, vi } from "vitest";
import { INVENTORY, inventoryRows, type InventoryEntry } from "./inventory.js";
import type { HostPorts } from "./ports.js";

const HOME = "/srv/me";

function fakePorts(present: Record<string, "file" | "dir">, dirs: Record<string, string[]> = {}) {
  const readFile = vi.fn(async () => "secret");
  const stat = vi.fn(async (path: string) => present[path] ?? null);
  const ports: HostPorts = {
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    readFile,
    stat,
    list: async (dir) => dirs[dir] ?? [],
    which: async () => null,
  };
  return { ports, readFile, stat };
}

describe("titan host doctor inventory rows", () => {
  it("checks a secret with stat and never opens it", async () => {
    const secrets = INVENTORY.filter((entry) => entry.categories.includes("c") && !entry.path.includes("*"));
    const present = Object.fromEntries(secrets.map((entry) => [`${HOME}/${entry.path.slice(2)}`, "file" as const]));
    const { ports, readFile, stat } = fakePorts(present);

    const rows = await inventoryRows(ports, HOME, "linux", secrets);

    expect(secrets.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === "ok")).toBe(true);
    expect(stat).toHaveBeenCalledWith(`${HOME}/.config/chezmoi/key.txt`);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("leaves a darwin-only row out on linux and keeps it on darwin", async () => {
    const plist = "~/Library/LaunchAgents/dev.hjewkes.titan-factory.plist";
    const { ports } = fakePorts({});

    const onLinux = await inventoryRows(ports, HOME, "linux");
    const onDarwin = await inventoryRows(ports, HOME, "darwin");

    expect(INVENTORY.find((entry) => entry.path === plist)?.platform).toBe("darwin");
    expect(onLinux.map((row) => row.id)).not.toContain(`inventory:${plist}`);
    expect(onDarwin.map((row) => row.id)).toContain(`inventory:${plist}`);
  });

  it("reports an absent per-owner config file as missing, and an absent optional one as warn", async () => {
    const entries: InventoryEntry[] = [
      { path: "~/.agent-chat/config.json", categories: ["b", "d"], platform: "both" },
      { path: "~/.agent-chat/mirror.env", categories: ["c"], platform: "both", optional: true },
    ];
    const { ports } = fakePorts({});

    const rows = await inventoryRows(ports, HOME, "linux", entries);

    expect(rows).toEqual([
      { id: "inventory:~/.agent-chat/config.json", group: "inventory", status: "missing", detail: "absent (b, d)" },
      { id: "inventory:~/.agent-chat/mirror.env", group: "inventory", status: "warn", detail: "absent (c)" },
    ]);
  });

  it("expands a profile wildcard to one row per profile directory", async () => {
    const entries: InventoryEntry[] = [{ path: "~/.claude-profiles/*/settings.json", categories: ["b"], platform: "both" }];
    const profiles = `${HOME}/.claude-profiles`;
    const { ports } = fakePorts(
      { [`${profiles}/alpha`]: "dir", [`${profiles}/beta`]: "dir", [`${profiles}/alpha/settings.json`]: "file", [`${profiles}/notes.txt`]: "file" },
      { [profiles]: ["beta", "notes.txt", "alpha"] },
    );

    const rows = await inventoryRows(ports, HOME, "linux", entries);

    expect(rows.map((row) => [row.id, row.status])).toEqual([
      ["inventory:~/.claude-profiles/alpha/settings.json", "ok"],
      ["inventory:~/.claude-profiles/beta/settings.json", "missing"],
    ]);
  });

  it("reports a wildcard with no directories under it as one missing row", async () => {
    const entries: InventoryEntry[] = [{ path: "~/.claude-profiles/*/settings.json", categories: ["b"], platform: "both" }];

    const rows = await inventoryRows(fakePorts({}).ports, HOME, "linux", entries);

    expect(rows).toEqual([
      { id: "inventory:~/.claude-profiles/*/settings.json", group: "inventory", status: "missing", detail: "absent (b)" },
    ]);
  });
});
