import { describe, expect, it } from "vitest";
import { containsGuarded, GUARDED_PATHS, hasGlob, matchGlob, matchGuarded, toAbsolute } from "./paths.js";

const HOME = "/home/you";
const REPO_DIR = "/home/you/projects/app";
const secretId = (path: string) => matchGuarded(path, GUARDED_PATHS.secret, HOME)?.id ?? null;

describe("matchGuarded", () => {
  it("matches a guarded path exactly", () => {
    expect(secretId("/home/you/.npmrc")).toBe("home:.npmrc");
  });

  it.each([
    "/home/you/.npmrc2",
    "/home/you/x/.npmrc",
    "/home/you/.npmrc.d/x",
    "/home/user/.npmrc",
    "/home/you/.agent-chat/old/ui.token",
  ])(
    "does not match %s: matching is by whole segment",
    (path) => {
      expect(secretId(path)).toBeNull();
    },
  );

  it("covers a directory pattern's own directory and everything under it, minus its exceptions", () => {
    expect(secretId("/home/you/.ssh")).toBe("home:.ssh");
    expect(secretId("/home/you/.ssh/keys/id_work")).toBe("home:.ssh");
    expect(secretId("/home/you/.ssh/id_ed25519.pub")).toBeNull();
    expect(secretId("/home/you/.ssh/known_hosts")).toBeNull();
    expect(secretId("/home/you/.sshx/id_rsa")).toBeNull();
  });

  it("matches .env files in any directory except the example files", () => {
    expect(secretId("/home/you/projects/app/.env")).toBe("any:.env");
    expect(secretId("/srv/app/.env.production")).toBe("any:.env.*");
    expect(secretId("/home/you/projects/app/.env.example")).toBeNull();
    expect(secretId("/home/you/projects/app/.envrc")).toBeNull();
  });

  it("anchors home patterns at the given home", () => {
    expect(matchGuarded("/srv/other/.npmrc", GUARDED_PATHS.secret, "/srv/other")?.id).toBe("home:.npmrc");
    expect(matchGuarded("/srv/other/.npmrc", GUARDED_PATHS.secret, HOME)).toBeNull();
  });
});

describe("matchGlob", () => {
  it("tests a typed glob against the guarded list", () => {
    expect(matchGlob("/home/you/.np*rc", GUARDED_PATHS.secret, HOME)?.id).toBe("home:.npmrc");
    expect(matchGlob("/home/you/.ssh/id_*", GUARDED_PATHS.secret, HOME)?.id).toBe("home:.ssh");
    expect(matchGlob("/home/you/projects/app/.en?", GUARDED_PATHS.secret, HOME)?.id).toBe("any:.env");
    expect(matchGlob("/home/you/.[n]etrc", GUARDED_PATHS.secret, HOME)?.id).toBe("home:.netrc");
  });

  it("does not match a glob that only reaches public files", () => {
    expect(matchGlob("/home/you/.ssh/*.pub", GUARDED_PATHS.secret, HOME)).toBeNull();
    expect(matchGlob("/home/you/projects/*.ts", GUARDED_PATHS.secret, HOME)).toBeNull();
  });
});

describe("containsGuarded", () => {
  it("finds a directory that holds a guarded path", () => {
    expect(containsGuarded("/home/you/.config", GUARDED_PATHS.secret, HOME)?.id).toBe("home:.config/gh/hosts.yml");
    expect(containsGuarded("/", GUARDED_PATHS.secret, HOME)).not.toBeNull();
    expect(containsGuarded("/home/you/projects", GUARDED_PATHS.secret, HOME)).toBeNull();
  });
});

describe("toAbsolute", () => {
  it("expands ~, $HOME and ${HOME} and normalises", () => {
    expect(toAbsolute("~/a/../.npmrc", REPO_DIR, HOME)).toEqual(["/home/you/.npmrc"]);
    expect(toAbsolute("$HOME/.npmrc", null, HOME)).toEqual(["/home/you/.npmrc"]);
    expect(toAbsolute("${HOME}", null, HOME)).toEqual(["/home/you"]);
  });

  it("assumes both home and the root when the directory is unknown", () => {
    expect(toAbsolute(".npmrc", null, HOME)).toEqual(["/home/you/.npmrc", "/.npmrc"]);
  });
});

describe("GUARDED_PATHS data", () => {
  const entries = [...GUARDED_PATHS.secret.paths, ...GUARDED_PATHS.config.paths];

  it.each(entries.filter((e) => hasGlob(e.pattern)).map((e) => [e.id, e] as const))(
    "%s has samples its own pattern covers",
    (_id, entry) => {
      const list = { paths: [entry], basenames: [] };
      const absolute = (s: string) => (s.startsWith("~/") || s.startsWith("/") ? s : `/somewhere/${s}`);

      expect(entry.samples?.length).toBeGreaterThan(0);
      for (const sample of entry.samples ?? []) {
        expect(toAbsolute(absolute(sample), null, HOME).map((p) => matchGuarded(p, list, HOME)?.id)).toContain(entry.id);
      }
    },
  );

  it("has unique ids", () => {
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });
});
