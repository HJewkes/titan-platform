import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeProjectSlug } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTempHome, type TempHome } from "./home.fixture.js";
import { instructionFacts, scanInstructions } from "./instructions.js";

const THREE_HEADINGS = "# Title\n\nPreamble.\n\n## Testing\n\nRun tests.\n\n## Git\n\nSmall commits.\n\n```\n## not a heading\n```\n\n## Style\n\nPlain code.\n";

let temp: TempHome;
let configDir: string;
let projectDir: string;
let projectFolder: string;

const roots = () => [{ root: path.join(configDir, "projects"), account: "default" }];

beforeEach(() => {
  temp = useTempHome();
  configDir = path.join(temp.home, ".claude");
  projectDir = path.join(temp.home, "work", "my-app");
  projectFolder = projectDir.replace(/[/.]/g, "-");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(path.join(configDir, "projects", projectFolder), { recursive: true });
});

afterEach(() => temp.restore());

describe("scanInstructions", () => {
  it("splits a project CLAUDE.md with three headings into three sections with its project and path", () => {
    writeFileSync(path.join(projectDir, "CLAUDE.md"), THREE_HEADINGS);

    const sections = scanInstructions(roots());

    expect(sections.map((section) => section.heading)).toEqual(["Testing", "Git", "Style"]);
    expect(sections[0]).toMatchObject({ account: "default", project: projectFolder, path: path.join(projectDir, "CLAUDE.md"), body: "Run tests." });
    expect(sections[1]?.body).toBe("Small commits.\n\n```\n## not a heading\n```");
  });

  it("finds a project CLAUDE.md whose path has an underscore and a space", () => {
    const odd = path.join(temp.home, "my_work", "a b");
    mkdirSync(odd, { recursive: true });
    writeFileSync(path.join(odd, "CLAUDE.md"), "## Odd\n\nBody.\n");
    mkdirSync(path.join(configDir, "projects", claudeProjectSlug(odd)), { recursive: true });

    expect(scanInstructions(roots()).map((section) => section.heading)).toEqual(["Odd"]);
  });

  it("reads the global CLAUDE.md beside the projects dir as project global", () => {
    writeFileSync(path.join(configDir, "CLAUDE.md"), "## Output\n\nBe brief.\n");

    expect(scanInstructions(roots())).toEqual([
      { account: "default", project: "global", path: path.join(configDir, "CLAUDE.md"), heading: "Output", body: "Be brief." },
    ]);
  });

  it("returns none for a missing CLAUDE.md", () => {
    expect(scanInstructions(roots())).toEqual([]);
  });

  it("returns none for a symlinked CLAUDE.md", () => {
    const target = path.join(temp.home, "elsewhere.md");
    writeFileSync(target, THREE_HEADINGS);
    symlinkSync(target, path.join(projectDir, "CLAUDE.md"));
    symlinkSync(target, path.join(configDir, "CLAUDE.md"));

    expect(scanInstructions(roots())).toEqual([]);
  });

  it("skips the project CLAUDE.md of a mirrored host root", () => {
    writeFileSync(path.join(projectDir, "CLAUDE.md"), THREE_HEADINGS);

    expect(scanInstructions([{ ...roots()[0]!, host: "other" }])).toEqual([]);
  });
});

describe("instructionFacts", () => {
  it("turns each section into a never-deletable fact with the same source", () => {
    const [fact] = instructionFacts([{ account: "default", project: "global", path: "/x/CLAUDE.md", heading: "Output", body: "Be brief." }]);

    expect(fact).toMatchObject({ ok: true, name: "Output", type: "user", body: "Be brief.", ref: { account: "default", project: "global", path: "/x/CLAUDE.md" } });
  });
});
