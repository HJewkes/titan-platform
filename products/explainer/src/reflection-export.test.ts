import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportReflection, ownerInboxDir, type ReflectionConfig, type ReflectionScript } from "./reflection-export.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function setup(mode: ReflectionConfig["mode"] = "deposit") {
  const root = mkdtempSync(path.join(tmpdir(), "reflection-"));
  dirs.push(root);
  const config: ReflectionConfig = { mode, asker: "acme-seat", spoolDir: path.join(root, "spool"), retroDir: path.join(root, "retros") };
  return { root, config, outDir: path.join(root, "out") };
}

const script: ReflectionScript = {
  beats: [
    { id: "b1", chapter: "lanes", spoken: "Lane one merged four.", fact_ids: ["lane/one/rollup"] },
    { id: "b2", chapter: "reflection", spoken: "Reviews wait too long.", fact_ids: ["slow/gate-wait/review"] },
    { id: "b3", chapter: "reflection", spoken: "Batch the small merges.", fact_ids: [] },
  ],
};
const run = (outDir: string, scriptSha = "sha-a") => ({ script, scriptSha, videoId: "vid-1", day: "2030-01-02", outDir });
const deposits = (spool: string) => readdirSync(spool).filter((name) => name.endsWith(".json"));

describe("exportReflection", () => {
  it("files one deposit when the same video and script export twice", async () => {
    const { config, outDir } = setup();

    const first = await exportReflection(config, run(outDir));
    const second = await exportReflection(config, run(outDir));

    expect([first.filed, second.filed]).toEqual(["created", "existing"]);
    expect(deposits(config.spoolDir)).toHaveLength(1);
  });

  it("files a new deposit when the script changes", async () => {
    const { config, outDir } = setup();

    await exportReflection(config, run(outDir, "sha-a"));
    await exportReflection(config, run(outDir, "sha-b"));

    expect(deposits(config.spoolDir)).toHaveLength(2);
  });

  it("writes reflection.md with each proposal and the fact it cites", async () => {
    const { config, outDir } = setup();

    const result = await exportReflection(config, run(outDir));

    const text = readFileSync(result.file, "utf8");
    expect(text).toContain("- Reviews wait too long. (slow/gate-wait/review)");
    expect(text).toContain("- Batch the small merges.");
    expect(text).not.toContain("Lane one");
  });

  it("writes a dated retro file instead of a deposit in retro-file mode, once", async () => {
    const { config, outDir } = setup("retro-file");

    const first = await exportReflection(config, run(outDir));
    const second = await exportReflection(config, run(outDir));

    expect([first.filed, second.filed]).toEqual(["created", "existing"]);
    expect(readdirSync(config.retroDir!)).toEqual(["2030-01-02-daily.md"]);
    expect(() => readdirSync(config.spoolDir)).toThrow();
  });

  it("files nothing for a script with no reflection chapter", async () => {
    const { config, outDir } = setup();

    const result = await exportReflection(config, { ...run(outDir), script: { beats: [script.beats[0]!] } });

    expect(result.filed).toBe("none");
    expect(() => readdirSync(config.spoolDir)).toThrow();
  });

  it("turns a refused deposit into a note", async () => {
    const { config, outDir } = setup();

    const result = await exportReflection({ ...config, asker: "" }, run(outDir));

    expect(result.filed).toBe("none");
    expect(result.notes[0]).toContain("reflection not filed");
  });
});

describe("ownerInboxDir", () => {
  it("prefers the explicit inbox variable over the state directory", () => {
    const home = path.join(tmpdir(), "fake-home");

    expect(ownerInboxDir({ TITAN_CONSOLE_INBOX_DIR: "~/inbox", TITAN_CONSOLE_STATE: "~/state" }, home)).toBe(path.join(home, "inbox"));
    expect(ownerInboxDir({}, home)).toBe(path.join(home, ".local/state/titan-console/inbox/deposits"));
  });
});
