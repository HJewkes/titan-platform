import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempHome, removeTempHome } from "../fixtures/temp-home.js";
import { CONFIG_DIRS_ENV, PROFILE_ROOT_ENV, discoverProfiles } from "./profiles.js";

let home: string;

beforeEach(() => {
  home = makeTempHome();
});

afterEach(() => {
  removeTempHome(home);
});

function makeDirs(...dirs: string[]): void {
  for (const dir of dirs) fs.mkdirSync(path.join(home, dir), { recursive: true });
}

describe("discoverProfiles", () => {
  it("lists ~/.claude first, then each profile dir in name order", () => {
    makeDirs(".claude", ".claude-profiles/workout", ".claude-profiles/agents");

    expect(discoverProfiles({ home, env: {} })).toEqual([
      { label: "default", configDir: path.join(home, ".claude") },
      { label: "agents", configDir: path.join(home, ".claude-profiles", "agents") },
      { label: "workout", configDir: path.join(home, ".claude-profiles", "workout") },
    ]);
  });

  it("skips files and symlinks in the profiles dir", () => {
    makeDirs(".claude-profiles/agents", "elsewhere");
    fs.writeFileSync(path.join(home, ".claude-profiles", "notes.txt"), "");
    fs.symlinkSync(path.join(home, "elsewhere"), path.join(home, ".claude-profiles", "linked"));

    expect(discoverProfiles({ home, env: {} }).map((profile) => profile.label)).toEqual(["agents"]);
  });

  it("skips a ~/.claude or ~/.claude-profiles that is a symlink", () => {
    makeDirs("real/agents");
    fs.symlinkSync(path.join(home, "real"), path.join(home, ".claude"));
    fs.symlinkSync(path.join(home, "real"), path.join(home, ".claude-profiles"));

    expect(discoverProfiles({ home, env: {} })).toEqual([]);
  });

  it("lists only profiles when ~/.claude is absent", () => {
    makeDirs(".claude-profiles/agents");

    expect(discoverProfiles({ home, env: {} }).map((profile) => profile.label)).toEqual(["agents"]);
  });

  it("finds nothing in an empty home", () => {
    expect(discoverProfiles({ home, env: {} })).toEqual([]);
  });

  it("takes CLAUDE_CONFIG_DIRS as given instead of scanning", () => {
    makeDirs(".claude");
    const dirs = [path.join(home, "a", ".claude"), path.join(home, "b", "agents")];

    const profiles = discoverProfiles({ home, env: { [CONFIG_DIRS_ENV]: dirs.join(path.delimiter) + path.delimiter } });

    expect(profiles).toEqual([
      { label: "default", configDir: dirs[0] },
      { label: "agents", configDir: dirs[1] },
    ]);
  });

  it("scans CLAUDE_PROFILE_ROOT instead of ~/.claude-profiles when it is set", () => {
    makeDirs(".claude", ".claude-profiles/ignored", "accounts/agents");

    const profiles = discoverProfiles({ home, env: { [PROFILE_ROOT_ENV]: path.join(home, "accounts") } });

    expect(profiles).toEqual([
      { label: "default", configDir: path.join(home, ".claude") },
      { label: "agents", configDir: path.join(home, "accounts", "agents") },
    ]);
  });

  it("scans ~/.claude-profiles when CLAUDE_PROFILE_ROOT is empty", () => {
    makeDirs(".claude-profiles/agents");

    expect(discoverProfiles({ home, env: { [PROFILE_ROOT_ENV]: "" } }).map((profile) => profile.label)).toEqual([
      "agents",
    ]);
  });

  it("scans when CLAUDE_CONFIG_DIRS is empty", () => {
    makeDirs(".claude");

    expect(discoverProfiles({ home, env: { [CONFIG_DIRS_ENV]: "" } }).map((profile) => profile.label)).toEqual([
      "default",
    ]);
  });
});
