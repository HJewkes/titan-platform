import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { gatherReview, licenseCheck, parseLicenses, type GatherOptions } from "./gather.js";
import { ExplainerFactSchema, FACT_SOURCES, ReviewBundleSchema } from "./schemas.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/review-whiteboard", import.meta.url));
const PIN = "2ddf3eb6c13d97b1d04a932c21de9a92029adaf9";
const OFF_PIN = "0000000000000000000000000000000000000001";
const TOUR_KINDS = ["what-it-is", "entry-point", "read-first", "should-not", "integration-rec", "capability"];

const atPin = async () => PIN;
const temps: string[] = [];

function gather(overrides: Partial<GatherOptions> = {}) {
  return gatherReview({ reviewDir: FIXTURE, clonePath: "/clone/whiteboard", readHead: atPin, ...overrides });
}

async function fixtureCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gather-review-"));
  temps.push(dir);
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

async function editFile(dir: string, path: string, edit: (text: string) => string): Promise<void> {
  const file = join(dir, path);
  await writeFile(file, edit(await readFile(file, "utf8")));
}

function codes(result: Awaited<ReturnType<typeof gatherReview>>): string[] {
  return result.diagnostics.map((finding) => finding.code);
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("gatherReview over the whiteboard fixture", () => {
  it("returns a schema-valid bundle with facts from every source and every tour kind", async () => {
    const result = await gather();

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const bundle = ReviewBundleSchema.parse(result.bundle);
    expect(bundle.repo).toEqual({ url: "https://github.com/devdotfast/whiteboard", sha: PIN, clone: "/clone/whiteboard" });
    expect(bundle.coverage.unread).toBe(0);
    expect(new Set(result.facts.map((fact) => fact.source))).toEqual(new Set(FACT_SOURCES));
    expect(result.facts.map((fact) => fact.kind)).toEqual(expect.arrayContaining(TOUR_KINDS));
    for (const fact of result.facts) ExplainerFactSchema.parse(fact);
    expect(result.diagnostics.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("hashes every file it read and counts facts per source", async () => {
    const result = await gather();

    if (!result.ok) throw new Error("expected ok");
    expect(Object.keys(result.bundle.files_sha256)).toEqual([
      "digests/WB-W1-001.json",
      "digests/WB-W3-001.json",
      "ledger.tsv",
      "licenses.tsv",
      "README.md",
      "SUMMARY.md",
      "synthesis/current-label",
      "synthesis/final/claims-audit.tsv",
      "synthesis/final/topics-judged.tsv",
    ]);
    expect(result.bundle.counts).toMatchObject({ topic: 3, row: 3, claim: 3, digest: 2, readme: 3 });
  });

  it("refuses a non-final label with E-LABEL and no bundle", async () => {
    const dir = await fixtureCopy();
    await writeFile(join(dir, "synthesis/current-label"), "wave1\n");

    const result = await gather({ reviewDir: dir });

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("bundle");
    expect(codes(result)).toContain("E-LABEL");
  });

  it("refuses unread files with E-UNREAD", async () => {
    const dir = await fixtureCopy();
    await editFile(dir, "SUMMARY.md", (text) => text.replace("unread=0", "unread=3"));

    const result = await gather({ reviewDir: dir });

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["E-UNREAD"]);
  });

  it("refuses a clone off the pin with E-PIN", async () => {
    const result = await gather({ readHead: async () => OFF_PIN });

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["E-PIN"]);
  });

  it("refuses an unreadable clone with E-CLONE", async () => {
    const result = await gather({
      readHead: async () => {
        throw new Error("not a git repository");
      },
    });

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["E-CLONE"]);
  });

  it("resolves the pin from a README that writes its bullets in lower case", async () => {
    const dir = await fixtureCopy();
    await editFile(dir, "README.md", (text) => text.replace("- Remote:", "- remote:").replace("- HEAD:", "- head:"));

    const result = await gather({ reviewDir: dir });

    expect(codes(result)).not.toContain("E-PIN-UNKNOWN");
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.bundle.repo).toEqual({ url: "https://github.com/devdotfast/whiteboard", sha: PIN, clone: "/clone/whiteboard" });
  });

  it("refuses a README with no remote bullet with E-PIN-UNKNOWN", async () => {
    const dir = await fixtureCopy();
    await editFile(dir, "README.md", (text) => text.replace(/^- Remote:.*\n/m, ""));

    const result = await gather({ reviewDir: dir });

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["E-PIN-UNKNOWN"]);
  });

  it("skips a topics row a dropped tab has shortened, with W-BAD-ROW, and keeps the bundle", async () => {
    const dir = await fixtureCopy();
    await editFile(dir, "synthesis/final/topics-judged.tsv", (text) => {
      const [header, first, ...rest] = text.split("\n");
      return [header, first!.slice(0, first!.lastIndexOf("\t")), ...rest].join("\n");
    });

    const result = await gather({ reviewDir: dir });

    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "W-BAD-ROW", selector: "synthesis/final/topics-judged.tsv:L2" }),
    );
    expect(result.bundle.counts.topic).toBe(2);
  });

  it("refuses a review with no topics-judged.tsv with E-TOPICS", async () => {
    const dir = await fixtureCopy();
    await rm(join(dir, "synthesis/final/topics-judged.tsv"));

    const result = await gather({ reviewDir: dir });

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["E-TOPICS"]);
  });

  it("refuses a renamed TSV column with E-COLUMNS naming it", async () => {
    const dir = await fixtureCopy();
    await editFile(dir, "synthesis/final/claims-audit.tsv", (text) => text.replace("\tstatus\t", "\tverdict\t"));

    const result = await gather({ reviewDir: dir });

    expect(result.ok).toBe(false);
    const columns = result.diagnostics.find((finding) => finding.code === "E-COLUMNS");
    expect(columns?.message).toContain("status");
  });

  it("reports every fault at once instead of stopping at the first", async () => {
    const dir = await fixtureCopy();
    await writeFile(join(dir, "synthesis/current-label"), "wave1\n");

    const result = await gather({ reviewDir: dir, readHead: async () => OFF_PIN });

    expect(codes(result)).toEqual(expect.arrayContaining(["E-LABEL", "E-PIN"]));
  });

  it("warns W-NO-PAIN for a repo-argument gather with no pain fact and still returns the bundle", async () => {
    const result = await gather({ profile: "repo-argument" });

    expect(result.ok).toBe(true);
    expect(codes(result)).toContain("W-NO-PAIN");
  });

  it("does not ask a repo-tour gather for a pain fact", async () => {
    const result = await gather({ profile: "repo-tour" });

    expect(codes(result)).not.toContain("W-NO-PAIN");
  });

  it("refuses a tour whose SUMMARY lacks the read-first section, but only warns for an argument", async () => {
    const dir = await fixtureCopy();
    await editFile(dir, "SUMMARY.md", (text) => text.replace("## Five files to read first", "## Reading list"));

    const tour = await gather({ reviewDir: dir });
    const argument = await gather({ reviewDir: dir, profile: "repo-argument" });

    expect(codes(tour)).toContain("E-SECTION");
    expect(argument.ok).toBe(true);
    expect(codes(argument)).toContain("W-SECTION");
  });
});

describe("licenseCheck", () => {
  const licenses = parseLicenses(
    "prefix\tlicense\tevidence\n(root)\tMIT\tLICENSE\ndiffr/packages/viewer/themes/\tMPL-2.0\tx\ndiffr/\tMIT\ty\n",
  );

  it("takes the longest matching prefix", () => {
    const safe = licenseCheck(licenses);

    expect(safe("diffr/src/main.rs")).toBe(true);
    expect(safe("diffr/packages/viewer/themes/helix.toml")).toBe(false);
  });

  it("falls back to the root license, and treats no license as unsafe", () => {
    expect(licenseCheck(licenses)("store.ts")).toBe(true);
    expect(licenseCheck([])("store.ts")).toBe(false);
  });
});
