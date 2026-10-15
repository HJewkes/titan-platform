import { describe, expect, it } from "vitest";
import { execArg, quoteIfNeeded, servicePath, stableNodePath, SYSTEM_PATH, userUnitDir, type NodeProbe } from "./service.js";

const SYSTEM = SYSTEM_PATH.join(":");

function probeOf(links: Record<string, string>): NodeProbe {
  return {
    exists: (p) => p in links,
    realpath: (p) => {
      if (!(p in links)) throw new Error(`ENOENT ${p}`);
      return links[p]!;
    },
  };
}

describe("systemd escaping", () => {
  it("doubles % and $ in an ExecStart argument, then quotes it on a space", () => {
    expect(execArg("/srv/my x/50%/$HOME")).toBe('"/srv/my x/50%%/$$HOME"');
  });

  it("escapes a backslash before a quote, so neither is escaped twice", () => {
    expect(quoteIfNeeded('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("leaves a plain word bare", () => {
    expect(quoteIfNeeded("/opt/node/bin/node")).toBe("/opt/node/bin/node");
    expect(execArg("serve")).toBe("serve");
  });
});

describe("userUnitDir", () => {
  it("puts units under an absolute XDG_CONFIG_HOME", () => {
    expect(userUnitDir("/srv/h", "/cfg")).toBe("/cfg/systemd/user");
  });

  it("ignores a relative XDG_CONFIG_HOME and an unset one", () => {
    expect(userUnitDir("/srv/h", "rel/cfg")).toBe("/srv/h/.config/systemd/user");
    expect(userUnitDir("/srv/h")).toBe("/srv/h/.config/systemd/user");
  });
});

describe("stableNodePath", () => {
  const cellar = "/opt/homebrew/Cellar/node/22.1.0/bin/node";

  it("maps a Cellar path to the prefix bin/node symlink when it resolves to the same binary", () => {
    expect(stableNodePath(cellar, probeOf({ "/opt/homebrew/bin/node": cellar, [cellar]: cellar }))).toBe("/opt/homebrew/bin/node");
    const intel = "/usr/local/Cellar/node/22.1.0/bin/node";
    expect(stableNodePath(intel, probeOf({ "/usr/local/bin/node": intel, [intel]: intel }))).toBe("/usr/local/bin/node");
  });

  it("maps a versioned formula through the opt symlink", () => {
    const path = "/usr/local/Cellar/node@20/20.9.0/bin/node";

    expect(stableNodePath(path, probeOf({ "/usr/local/opt/node@20/bin/node": path, [path]: path }))).toBe("/usr/local/opt/node@20/bin/node");
  });

  it("keeps the Cellar path when the symlink is absent", () => {
    expect(stableNodePath(cellar, probeOf({ [cellar]: cellar }))).toBe(cellar);
  });

  it("keeps the Cellar path when the symlink points at a different binary", () => {
    const other = "/opt/homebrew/Cellar/node/23.0.0/bin/node";

    expect(stableNodePath(cellar, probeOf({ "/opt/homebrew/bin/node": other, [cellar]: cellar, [other]: other }))).toBe(cellar);
  });

  it("keeps a non-Homebrew path untouched", () => {
    expect(stableNodePath("/Users/x/.nvm/versions/node/v22/bin/node", probeOf({}))).toBe("/Users/x/.nvm/versions/node/v22/bin/node");
  });
});

describe("servicePath", () => {
  const tools: Record<string, string> = { gh: "/opt/tools/bin/gh", claude: "/opt/claude/bin/claude" };
  const which = (binary: string): string | undefined => tools[binary];

  it("with no binaries, names node's directory and then the system's", () => {
    expect(servicePath(which, "/opt/node/bin/node", [])).toEqual({ path: `/opt/node/bin:${SYSTEM}`, missing: [] });
  });

  it("names each directory once, however many entries share it", () => {
    expect(servicePath((binary) => `/usr/bin/${binary}`, "/usr/bin/node", ["gh", "claude"]).path).toBe(SYSTEM);
  });

  it("puts found binaries first and reports the missing ones", () => {
    expect(servicePath(which, "/opt/node/bin/node", ["gh", "agent-chat", "claude"])).toEqual({
      path: `/opt/tools/bin:/opt/claude/bin:/opt/node/bin:${SYSTEM}`,
      missing: ["agent-chat"],
    });
  });

  it("refuses a node directory or a binary directory with a ':'", () => {
    expect(() => servicePath(which, "/opt/x:rel/node", [])).toThrow(/\/opt\/x:rel\/node cannot go on the service PATH/);
    expect(() => servicePath(() => "/opt/cl:aude/bin/claude", "/opt/node/bin/node", ["claude"])).toThrow(/cannot go on the service PATH/);
  });
});
