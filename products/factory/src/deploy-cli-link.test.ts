import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { partialFake } from "@titan-design/test-kit";
import { relinkAfterDeploy, relinkCli } from "./deploy-cli-link.js";
import { deployedBinPath } from "./deploy-checkout.js";
import type { DeployPorts } from "./deploy.js";
import { plistPath } from "./service.js";

const HOME = "/srv/tester";
let dir: string;
let linkPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tp-2421-"));
  mkdirSync(join(dir, "bin"));
  linkPath = join(dir, "bin", "titan-factory");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const factoryBin = (tree: string): string => {
  const bin = join(dir, tree, "products", "factory", "dist", "bin.js");
  mkdirSync(join(bin, ".."), { recursive: true });
  writeFileSync(bin, `build:${tree}`);
  return bin;
};

describe("relinkCli", () => {
  it("repoints a symlink into a stale factory build at the deployed bin and leaves the old build intact", () => {
    const stale = factoryBin("stale");
    const fresh = factoryBin("fresh");
    symlinkSync(stale, linkPath);

    const outcome = relinkCli({ linkPath }, fresh);

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(fresh);
    expect(readFileSync(stale, "utf8")).toBe("build:stale");
    expect(outcome).toContain("repointed");
  });

  it("keeps a link that already points at the deployed bin untouched", () => {
    const fresh = factoryBin("fresh");
    symlinkSync(fresh, linkPath);
    const before = lstatSync(linkPath, { bigint: true });

    const outcome = relinkCli({ linkPath }, fresh);

    const after = lstatSync(linkPath, { bigint: true });
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs]);
    expect(outcome).toContain("already current");
  });

  it("leaves a regular file byte-identical and says so", () => {
    writeFileSync(linkPath, "#!/bin/sh\necho wrapper\n");

    const outcome = relinkCli({ linkPath }, factoryBin("fresh"));

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(linkPath, "utf8")).toBe("#!/bin/sh\necho wrapper\n");
    expect(outcome).toContain("not a symlink");
  });

  it("leaves a symlink to a non-factory target alone", () => {
    const foreign = join(dir, "other-tool");
    writeFileSync(foreign, "x");
    symlinkSync(foreign, linkPath);

    const outcome = relinkCli({ linkPath }, factoryBin("fresh"));

    expect(readlinkSync(linkPath)).toBe(foreign);
    expect(outcome).toContain("not a factory build");
  });

  it("does not create the link when the path is absent", () => {
    const outcome = relinkCli({ linkPath }, factoryBin("fresh"));

    expect(() => lstatSync(linkPath)).toThrow(/ENOENT/);
    expect(outcome).toContain("does not exist");
  });

  it("resolves a relative link target against the link's directory", () => {
    const stale = factoryBin("stale");
    symlinkSync(join("..", "stale", "products", "factory", "dist", "bin.js"), linkPath);
    const fresh = factoryBin("fresh");

    relinkCli({ linkPath }, fresh);

    expect(readlinkSync(linkPath)).toBe(fresh);
    expect(readFileSync(stale, "utf8")).toBe("build:stale");
  });
});

describe("relinkAfterDeploy", () => {
  const checkout = "/srv/tester/deploy/titan-platform";
  const bin = deployedBinPath(checkout);

  const run = (code: number, unitText: string): { out: string; err: string } => {
    const ports = partialFake<DeployPorts>({ platform: "darwin", home: HOME, readFile: (path: string) => (path === plistPath(HOME) ? unitText : undefined) });
    let out = "";
    let err = "";
    relinkAfterDeploy({ code, ports, checkout, link: { linkPath }, io: { stdout: (t) => void (out += t), stderr: (t) => void (err += t) } });
    return { out, err };
  };

  it("repoints a stale factory symlink after an exit-0 deploy whose service runs the checkout", () => {
    symlinkSync(factoryBin("stale"), linkPath);

    const { out } = run(0, `<string>${bin}</string>`);

    expect(readlinkSync(linkPath)).toBe(bin);
    expect(out).toContain("repointed");
  });

  it("leaves the link alone after a failed deploy", () => {
    const stale = factoryBin("stale");
    symlinkSync(stale, linkPath);

    run(1, `<string>${bin}</string>`);

    expect(readlinkSync(linkPath)).toBe(stale);
  });

  it("leaves the link alone after a prepare-only deploy whose service runs another tree", () => {
    const stale = factoryBin("stale");
    symlinkSync(stale, linkPath);

    run(0, "<string>/srv/dev-tree/products/factory/dist/bin.js</string>");

    expect(readlinkSync(linkPath)).toBe(stale);
  });

  it("warns instead of throwing when the relink fails", () => {
    mkdirSync(`${linkPath}.${process.pid}.tmp`);
    symlinkSync(factoryBin("stale"), linkPath);

    const { err } = run(0, `<string>${bin}</string>`);

    expect(err).toContain("could not repoint");
  });
});
