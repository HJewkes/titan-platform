import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { renderPlist, SERVICE_LABEL } from "./service.js";

const options = { nodePath: "/opt/node/bin/node", binPath: "/srv/factory/dist/bin.js", logDir: "/var/state/titan-factory" };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function keyValue(plist: string, key: string): string {
  const match = new RegExp(`<key>${key}</key>\\s*(<true/>|<false/>|<string>([^<]*)</string>)`).exec(plist);
  if (!match) throw new Error(`no ${key} in plist`);
  return match[2] ?? match[1]!;
}

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
    const args = (plist: string): string[] => [...plist.matchAll(/^ {4}<string>([^<]*)<\/string>$/gm)].map((m) => m[1]!);

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

    const code = await runCli(["service", "plist"], io);

    expect(code).toBe(0);
    expect(keyValue(out, "ProcessType")).toBe("Interactive");
    expect(out).toContain(`<string>${process.execPath}</string>`);
    expect(out).toMatch(/<string>\/[^<]*bin\.js<\/string>\s*<string>serve<\/string>/);
    expect(keyValue(out, "StandardOutPath")).toBe("/xdg/state/titan-factory/serve.out.log");
  });
});
