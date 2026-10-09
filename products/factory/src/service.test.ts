import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { configuredLabelPrefix, renderPlist, renderUnit, SERVICE_LABEL, serviceLabel, servicePath, stableNodePath, UNIT_NAME, unitPath, type NodeProbe } from "./service.js";
import { systemServicePorts } from "./service-ports.js";

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const options = { nodePath: "/opt/node/bin/node", binPath: "/srv/factory/dist/bin.js", logDir: "/var/state/titan-factory", path: `/opt/tools/bin:${SYSTEM_PATH}` };
const TOOLS: Record<string, string> = { gh: "/opt/tools/bin/gh", "agent-chat": "/srv/agents/bin/agent-chat", claude: "/opt/claude/bin/claude" };
const whichWithout = (...absent: string[]) => (binary: string): string | undefined => (absent.includes(binary) ? undefined : TOOLS[binary]);
const pathOf = (plist: string): string[] => keyValue(plist, "PATH").split(":");
/** The plist verb prints a unit on Linux, so these pin the platform; CI runs on Linux. */
const darwin = { workflows: [], routes: [], service: { ...systemServicePorts(), platform: "darwin" as const } };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function keyValue(plist: string, key: string): string {
  const match = new RegExp(`<key>${key}</key>\\s*(<true/>|<false/>|<string>([^<]*)</string>)`).exec(plist);
  if (!match) throw new Error(`no ${key} in plist`);
  return match[2] ?? match[1]!;
}

describe("service label prefix", () => {
  const home = (config?: unknown): NodeJS.ProcessEnv => {
    const dir = mkdtempSync(join(tmpdir(), "service-label-"));
    dirs.push(dir);
    if (config !== undefined) {
      mkdirSync(join(dir, "titan-factory"));
      writeFileSync(join(dir, "titan-factory", "config.json"), JSON.stringify(config));
    }
    return { XDG_CONFIG_HOME: dir };
  };

  it("keeps the default label byte-identical when the config sets no prefix", () => {
    expect(configuredLabelPrefix(home())).toBeUndefined();
    expect(serviceLabel(configuredLabelPrefix(home({})))).toBe("dev.hjewkes.titan-factory");
  });

  it("follows service.labelPrefix when the config sets one", () => {
    const prefix = configuredLabelPrefix(home({ service: { labelPrefix: "dev.ex." } }));

    expect(serviceLabel(prefix)).toBe("dev.ex.titan-factory");
  });
});

describe("titan-factory service plist", () => {
  it("names the job and keeps it running from load", () => {
    const plist = renderPlist(options);

    expect(keyValue(plist, "Label")).toBe(SERVICE_LABEL);
    expect(SERVICE_LABEL).toBe("dev.hjewkes.titan-factory");
    expect(keyValue(plist, "KeepAlive")).toBe("<true/>");
    expect(keyValue(plist, "RunAtLoad")).toBe("<true/>");
  });

  it("runs Interactive, because a Background job is throttled by macOS", () => {
    expect(keyValue(renderPlist(options), "ProcessType")).toBe("Interactive");
  });

  it("launches node on the built bin with serve, and the port when given", () => {
    const args = (plist: string): string[] => [...(/<array>([^]*?)<\/array>/.exec(plist)?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!);

    expect(args(renderPlist(options))).toEqual([options.nodePath, options.binPath, "serve"]);
    expect(args(renderPlist({ ...options, port: 7411 }))).toEqual([options.nodePath, options.binPath, "serve", "--port", "7411"]);
  });

  it("escapes XML in paths", () => {
    expect(renderPlist({ ...options, binPath: "/a&b/<x>/bin.js" })).toContain("<string>/a&amp;b/&lt;x&gt;/bin.js</string>");
  });

  it("writes stdout and stderr logs under the log directory", () => {
    const plist = renderPlist(options);

    expect(keyValue(plist, "StandardOutPath")).toBe(join(options.logDir, "serve.out.log"));
    expect(keyValue(plist, "StandardErrorPath")).toBe(join(options.logDir, "serve.err.log"));
  });

  it("gives the job a PATH, and no other environment variable", () => {
    const environment = /<key>EnvironmentVariables<\/key>\s*<dict>([^]*?)<\/dict>/.exec(renderPlist(options))?.[1] ?? "";

    expect([...environment.matchAll(/<key>([^<]*)<\/key>/g)].map((m) => m[1])).toEqual(["PATH"]);
    expect(keyValue(renderPlist(options), "PATH")).toBe(options.path);
  });

  it.runIf(process.platform === "darwin")("passes plutil -lint", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-plist-"));
    dirs.push(dir);
    const file = join(dir, "job.plist");
    writeFileSync(file, renderPlist(options));

    expect(() => execFileSync("plutil", ["-lint", file], { stdio: "pipe" })).not.toThrow();
  });

  it("the CLI verb prints the plist with absolute node and bin paths and state-dir logs", async () => {
    let out = "";
    const io = { stdout: (t: string) => void (out += t), stderr: () => undefined, env: { XDG_STATE_HOME: "/xdg/state" } };

    const code = await runCli(["service", "plist"], io, darwin);

    expect(code).toBe(0);
    expect(keyValue(out, "ProcessType")).toBe("Interactive");
    expect(out).toContain(`<string>${stableNodePath(process.execPath)}</string>`);
    expect(out).toMatch(/<string>\/[^<]*bin\.js<\/string>\s*<string>serve<\/string>/);
    expect(keyValue(out, "StandardOutPath")).toBe("/xdg/state/titan-factory/serve.out.log");
  });

  it("the CLI verb resolves the PATH through the service port, with a warning for each binary it cannot find", async () => {
    let out = "";
    let err = "";
    const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env: {} };
    const service = { ...darwin.service, which: whichWithout("claude") };

    const code = await runCli(["service", "plist", "--node", "/opt/node/bin/node"], io, { workflows: [], routes: [], service });

    expect(code).toBe(0);
    expect(pathOf(out)).toEqual(["/opt/tools/bin", "/srv/agents/bin", "/opt/node/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
    expect(err).toBe("warning: claude is not on PATH, so the service will not find it\n");
  });

  it("the CLI verb writes an explicit --node path as given", async () => {
    let out = "";
    const io = { stdout: (t: string) => void (out += t), stderr: () => undefined, env: {} };

    expect(await runCli(["service", "plist", "--node", "/custom/bin/node"], io, darwin)).toBe(0);

    expect(out).toContain("<string>/custom/bin/node</string>");
    expect(out).not.toContain(`<string>${stableNodePath(process.execPath)}</string>`);
  });

  it("escapes XML in PATH", () => {
    const plist = renderPlist({ ...options, path: `/opt/a&b/<x>/bin:${SYSTEM_PATH}` });

    expect(plist).toContain(`<string>/opt/a&amp;b/&lt;x&gt;/bin:${SYSTEM_PATH}</string>`);
    expect(plist).not.toContain("a&b");
  });

  it("the CLI verb refuses a --node with a colon, which would split into PATH entries", async () => {
    let out = "";
    let err = "";
    const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env: {} };

    expect(await runCli(["service", "plist", "--node", "/opt/x:rel/node"], io)).toBe(2);

    expect(out).toBe("");
    expect(err).toContain('must not contain ":"');
  });

  it("the CLI verb refuses a relative --node", async () => {
    let err = "";
    const io = { stdout: () => undefined, stderr: (t: string) => void (err += t), env: {} };

    expect(await runCli(["service", "plist", "--node", "bin/node"], io)).toBe(2);

    expect(err).toContain("absolute");
  });
});

const directive = (unit: string, key: string): string[] => [...unit.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!);

describe("titan-factory service unit", () => {
  it("is named after the launchd label without its owner prefix", () => {
    expect(UNIT_NAME).toBe("titan-factory.service");
  });

  it("keeps serve running from boot, as KeepAlive and RunAtLoad do", () => {
    const unit = renderUnit(options);

    expect(directive(unit, "Type")).toEqual(["simple"]);
    expect(directive(unit, "Restart")).toEqual(["always"]);
    expect(directive(unit, "RestartSec")).toEqual(["5"]);
    expect(directive(unit, "WantedBy")).toEqual(["default.target"]);
  });

  it("runs the plist's argv, with the port when given", () => {
    expect(directive(renderUnit(options), "ExecStart")).toEqual([`${options.nodePath} ${options.binPath} serve`]);
    expect(directive(renderUnit({ ...options, port: 7411 }), "ExecStart")).toEqual([`${options.nodePath} ${options.binPath} serve --port 7411`]);
  });

  it("sets the plist's PATH and no other variable", () => {
    expect(directive(renderUnit(options), "Environment")).toEqual([`PATH=${options.path}`]);
  });

  it("appends stdout and stderr to the plist's log files", () => {
    const unit = renderUnit(options);

    expect(directive(unit, "StandardOutput")).toEqual([`append:${join(options.logDir, "serve.out.log")}`]);
    expect(directive(unit, "StandardError")).toEqual([`append:${join(options.logDir, "serve.err.log")}`]);
  });

  it("quotes an argument or PATH with a space, and keeps % and $ literal", () => {
    const unit = renderUnit({ ...options, binPath: "/srv/my factory/dist/bin.js", nodePath: "/opt/n$de/bin/node", path: "/opt/100%/bin:/opt/a b/bin", logDir: "/var/log dir/50%" });

    expect(directive(unit, "ExecStart")).toEqual(['/opt/n$$de/bin/node "/srv/my factory/dist/bin.js" serve']);
    expect(directive(unit, "Environment")).toEqual(['"PATH=/opt/100%%/bin:/opt/a b/bin"']);
    expect(directive(unit, "StandardOutput")).toEqual(["append:/var/log dir/50%%/serve.out.log"]);
  });

  it("escapes a backslash or double quote inside a quoted argument", () => {
    expect(directive(renderUnit({ ...options, binPath: '/srv/a"b\\c/bin.js' }), "ExecStart")).toEqual([`${options.nodePath} "/srv/a\\"b\\\\c/bin.js" serve`]);
  });

  it("lives under XDG_CONFIG_HOME when it is absolute, else under ~/.config", () => {
    expect(unitPath("/srv/tester")).toBe("/srv/tester/.config/systemd/user/titan-factory.service");
    expect(unitPath("/srv/tester", "/xdg/config")).toBe("/xdg/config/systemd/user/titan-factory.service");
    expect(unitPath("/srv/tester", "relative/config")).toBe("/srv/tester/.config/systemd/user/titan-factory.service");
  });
});

/** Symlinks map a path to the Cellar binary they point at; anything else is absent, and realpath throws on it like the real one. */
function probeOf(links: Record<string, string>): NodeProbe {
  return {
    exists: (p) => p in links,
    realpath: (p) => {
      if (!(p in links)) throw new Error(`ENOENT ${p}`);
      return links[p]!;
    },
  };
}

describe("servicePath", () => {
  it("names the directories of gh, agent-chat, claude and node, then launchd's own", () => {
    expect(servicePath(whichWithout(), "/opt/node/bin/node")).toEqual({
      path: `/opt/tools/bin:/srv/agents/bin:/opt/claude/bin:/opt/node/bin:${SYSTEM_PATH}`,
      missing: [],
    });
  });

  it("names a directory once, however many binaries share it", () => {
    const shared = (binary: string): string => `/usr/bin/${binary}`;

    expect(servicePath(shared, "/usr/bin/node").path).toBe(SYSTEM_PATH);
  });

  it("leaves out a binary that is not found and reports it", () => {
    expect(servicePath(whichWithout("gh", "claude"), "/opt/node/bin/node")).toEqual({
      path: `/srv/agents/bin:/opt/node/bin:${SYSTEM_PATH}`,
      missing: ["gh", "claude"],
    });
  });
});

describe("servicePath: a directory with a colon", () => {
  it("refuses a node path whose directory would split into two PATH entries", () => {
    expect(() => servicePath(whichWithout(), "/opt/x:rel/node")).toThrow(/\/opt\/x:rel\/node cannot go on the service PATH/);
    expect(() => servicePath(whichWithout(), "/opt/x:/node")).toThrow(/cannot go on the service PATH/);
  });

  it("refuses a found binary whose directory has one", () => {
    const which = (binary: string): string | undefined => (binary === "claude" ? "/opt/cl:aude/bin/claude" : TOOLS[binary]);

    expect(() => servicePath(which, "/opt/node/bin/node")).toThrow(/\/opt\/cl:aude\/bin\/claude cannot go on the service PATH/);
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
