import type * as Fs from "node:fs";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { partialFake } from "@titan-design/test-kit";
import { renameSync, unlinkSync } from "node:fs";
import { relinkAfterDeploy, relinkCli } from "./deploy-cli-link.js";
import { deployedBinPath } from "./deploy-checkout.js";
import type { DeployPorts } from "./deploy.js";
import { plistPath } from "./service.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), unlinkSync: vi.fn(actual.unlinkSync) };
});

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
  describe("when the rename fails after the temp link is staged", () => {
    // The link must pass relinkCli's lstat check, so the rename itself is made to fail.
    const failRenameOnce = (): void => {
      vi.mocked(renameSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("rename refused"), { code: "EXDEV" });
      });
    };
    const stage = (): string => {
      const fresh = factoryBin("fresh");
      symlinkSync(factoryBin("stale"), linkPath);
      return fresh;
    };
    const tmpEntries = (): string[] => readdirSync(join(dir, "bin")).filter((name) => name.endsWith(".tmp"));

    it("rethrows the rename error and leaves no tmp entry", () => {
      const fresh = stage();
      failRenameOnce();
      expect(() => relinkCli({ linkPath }, fresh)).toThrow("rename refused");
      expect(tmpEntries()).toEqual([]);
    });

    it("keeps the rename error and attaches the unlink failure as cause", () => {
      const fresh = stage();
      failRenameOnce();
      const unlinkFailure = new Error("unlink denied");
      vi.mocked(unlinkSync).mockImplementationOnce(() => {
        throw unlinkFailure;
      });

      let thrown: unknown;
      try {
        relinkCli({ linkPath }, fresh);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).toMatchObject({ message: "rename refused", cause: unlinkFailure });
    });
  });

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

  it("succeeds and keeps a leftover temp file from a crashed earlier run", () => {
    const fresh = factoryBin("fresh");
    symlinkSync(factoryBin("stale"), linkPath);
    const leftover = `${linkPath}.${process.pid}.tmp`;
    writeFileSync(leftover, "crashed run");

    const outcome = relinkCli({ linkPath }, fresh);

    expect(readlinkSync(linkPath)).toBe(fresh);
    expect(readFileSync(leftover, "utf8")).toBe("crashed run");
    expect(outcome).toContain("repointed");
  });

  it("leaves the link alone when the bin is not absolute", () => {
    const stale = factoryBin("stale");
    symlinkSync(stale, linkPath);

    const outcome = relinkCli({ linkPath }, "products/factory/dist/bin.js");

    expect(readlinkSync(linkPath)).toBe(stale);
    expect(outcome).toContain("not absolute");
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

  it.skipIf(process.getuid?.() === 0)("warns instead of throwing when the relink fails and leaves no temp link behind", () => {
    symlinkSync(factoryBin("stale"), linkPath);
    chmodSync(join(dir, "bin"), 0o500);

    let err: string;
    try {
      ({ err } = run(0, `<string>${bin}</string>`));
    } finally {
      chmodSync(join(dir, "bin"), 0o700);
    }
    expect(err).toContain("could not repoint");
    expect(readdirSync(join(dir, "bin"))).toEqual(["titan-factory"]);
  });
});
