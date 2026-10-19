import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { joinSurfaces } from "./catalog.js";
import { hostSurfaceRootsFrom, hostSurfaces } from "./host.js";

let root: string;

async function write(file: string, body: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(body));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "host-surfaces-"));
  await write(path.join(root, ".agent-chat", "config.json"), { worktreeBudget: 12 });
  await write(path.join(root, ".agent-chat", "profiles", "worker-a.json"), { model: "model-a" });
  await write(path.join(root, ".config", "titan-factory", "config.json"), { shepherd: { spawnGate: { load5: 48 } } });
  await write(path.join(root, ".claude", "settings.json"), { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } });
  await write(path.join(root, ".claude", ".claude.json"), { projects: {} });
  await mkdir(path.join(root, ".claude-profiles"));
  await writeFile(path.join(root, "CLAUDE.md"), "# Rules\n\nKeep at most 12 per repo.\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("hostSurfaces", () => {
  it("covers inventory #7, #8, #14-17, #19 and #22 from the default paths under home", async () => {
    const roots = hostSurfaceRootsFrom({ TITAN_CONSOLE_PORT: "7501" }, root);

    const surfaces = joinSurfaces(await Promise.all(hostSurfaces(roots).map((read) => read())));

    expect(surfaces.gaps).toEqual([]);
    expect([...new Set(surfaces.files.map((file) => file.inventory))].sort((a, b) => a - b)).toEqual([7, 8, 14, 15, 17, 19, 22]);
    expect(surfaces.rows.find((entry) => entry.field === "hooks.Stop")?.value).toEqual([{ matcher: null, commands: ["say done"] }]);
  });

  it("reads only the stated worktree cap and its line out of the home CLAUDE.md", async () => {
    await writeFile(path.join(root, "CLAUDE.md"), "# Rules\n\nprivate-prose-3c1e\nWorktrees: (24 per repo, kept small)\n");
    const roots = hostSurfaceRootsFrom({}, root);

    const surfaces = joinSurfaces(await Promise.all(hostSurfaces(roots).map((read) => read())));

    expect(surfaces.rows.filter((entry) => entry.surface === "claude-md")).toEqual([
      { surface: "claude-md", file: path.join(root, "CLAUDE.md"), field: "worktreesPerRepo", line: 4, hidden: false, value: 24, decisions: [] },
    ]);
    expect(JSON.stringify(surfaces)).not.toContain("private-prose-3c1e");
  });

  it("reports a CLAUDE.md that states no worktree cap as a gap, with no row", async () => {
    await writeFile(path.join(root, "CLAUDE.md"), "# Rules\n");

    const surfaces = joinSurfaces(await Promise.all(hostSurfaces(hostSurfaceRootsFrom({}, root)).map((read) => read())));

    expect(surfaces.gaps).toEqual([`${path.join(root, "CLAUDE.md")}: states no per-repo worktree cap`]);
    expect(surfaces.rows.filter((entry) => entry.surface === "claude-md")).toEqual([]);
  });

  it("reads the Claude dirs named in TITAN_CONSOLE_CLAUDE_DIRS instead of the defaults", () => {
    const roots = hostSurfaceRootsFrom({ TITAN_CONSOLE_CLAUDE_DIRS: "~/acct-a, /srv/acct-b", XDG_CONFIG_HOME: "/srv/xdg" }, root);

    expect(roots.claude).toEqual({ dirs: [path.join(root, "acct-a"), "/srv/acct-b"], profilesDir: null });
    expect(roots.factoryConfigPath).toBe(path.join("/srv/xdg", "titan-factory", "config.json"));
  });
});
