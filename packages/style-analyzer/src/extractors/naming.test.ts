import { describe, it, expect, beforeAll } from "vitest";
import { NamingExtractor } from "./naming.js";
import { parseFile } from "@titan-design/code-parser";
import type { ParsedFile } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixture(filename: string, language: string): Promise<ParsedFile> {
  const fixturePath = path.join(__dirname, "../../fixtures", filename);
  const content = fs.readFileSync(fixturePath, "utf-8");
  return parseFile(content, fixturePath, language);
}

describe("NamingExtractor", () => {
  const extractor = new NamingExtractor();

  describe("TypeScript", () => {
    let observations: ReturnType<NamingExtractor["extract"]>;

    beforeAll(async () => {
      const parsed = await loadFixture("naming-sample.ts", "typescript");
      observations = extractor.extract(parsed);
    });

    it("has name 'naming'", () => {
      expect(extractor.name).toBe("naming");
    });

    it("detects camelCase variables", () => {
      const vars = observations.filter(
        (o) => o.type === "naming.variable" && o.value === "camelCase",
      );
      expect(vars.length).toBeGreaterThanOrEqual(2);
    });

    it("detects SCREAMING_SNAKE constants", () => {
      const constants = observations.filter(
        (o) => o.type === "naming.constant" && o.value === "SCREAMING_SNAKE",
      );
      expect(constants.length).toBe(2);
    });

    it("detects camelCase functions", () => {
      const fns = observations.filter(
        (o) => o.type === "naming.function" && o.value === "camelCase",
      );
      expect(fns.length).toBeGreaterThanOrEqual(2);
    });

    it("detects PascalCase types", () => {
      const types = observations.filter(
        (o) => o.type === "naming.type" && o.value === "PascalCase",
      );
      expect(types.length).toBeGreaterThanOrEqual(2);
    });

    it("detects boolean prefixes", () => {
      const booleans = observations.filter(
        (o) => o.type === "naming.boolean",
      );
      expect(booleans.length).toBeGreaterThanOrEqual(3);
      booleans.forEach((b) => {
        expect(["is", "has", "should"]).toContain(b.value);
      });
    });

    it("detects PascalCase enum", () => {
      const enums = observations.filter(
        (o) => o.type === "naming.enum",
      );
      expect(enums.length).toBeGreaterThanOrEqual(1);
      expect(enums[0]!.value).toBe("PascalCase");
    });

    it("detects camelCase parameters", () => {
      const params = observations.filter(
        (o) => o.type === "naming.parameter" && o.value === "camelCase",
      );
      expect(params.length).toBeGreaterThanOrEqual(2);
    });

    it("detects private member prefix", () => {
      const priv = observations.filter(
        (o) => o.type === "naming.private-member",
      );
      expect(priv.length).toBeGreaterThanOrEqual(1);
      expect(priv[0]!.value).toBe("underscore-prefix");
    });

    it("sets correct category on all observations", () => {
      observations.forEach((o) => {
        expect(o.category).toBe("naming");
      });
    });
  });

  describe("Python", () => {
    let observations: ReturnType<NamingExtractor["extract"]>;

    beforeAll(async () => {
      const parsed = await loadFixture("naming-sample.py", "python");
      observations = extractor.extract(parsed);
    });

    it("detects snake_case variables", () => {
      const vars = observations.filter(
        (o) => o.type === "naming.variable" && o.value === "snake_case",
      );
      expect(vars.length).toBeGreaterThanOrEqual(2);
    });

    it("detects snake_case functions", () => {
      const fns = observations.filter(
        (o) => o.type === "naming.function" && o.value === "snake_case",
      );
      expect(fns.length).toBeGreaterThanOrEqual(2);
    });

    it("detects PascalCase classes", () => {
      const types = observations.filter(
        (o) => o.type === "naming.type" && o.value === "PascalCase",
      );
      expect(types.length).toBeGreaterThanOrEqual(1);
    });

    it("detects boolean prefixes in Python", () => {
      const booleans = observations.filter(
        (o) => o.type === "naming.boolean",
      );
      expect(booleans.length).toBeGreaterThanOrEqual(2);
    });

    it("reports the fixture's module-level constants as constants, not variables", () => {
      const constants = observations.filter((o) => o.type === "naming.constant");
      const screamingVars = observations.filter(
        (o) => o.type === "naming.variable" && o.value === "SCREAMING_SNAKE",
      );
      expect(constants.map((o) => o.line)).toEqual([8, 9]);
      expect(screamingVars).toEqual([]);
    });
  });

  describe("Python assignment shapes", () => {
    async function namesOf(source: string): Promise<string[]> {
      const parsed = await parseFile(source, "snippet.py", "python");
      return extractor
        .extract(parsed)
        .filter((o) => o.type === "naming.constant" || o.type === "naming.variable")
        .map((o) => `${o.line} ${o.type} ${o.value}`);
    }

    it("classifies plain, annotated and chained module-level assignments as constants", async () => {
      const names = await namesOf("MAX_RETRIES = 3\nTIMEOUT_S: int = 30\nX_ONE = Y_TWO = 5\n");
      expect(names).toEqual([
        "1 naming.constant SCREAMING_SNAKE",
        "2 naming.constant SCREAMING_SNAKE",
        "3 naming.constant SCREAMING_SNAKE",
        "3 naming.constant SCREAMING_SNAKE",
      ]);
    });

    it("classifies caps names in module-scope try, if and with blocks as constants", async () => {
      const source = [
        "try:",
        "    import lzma",
        "    HAS_LZMA = True",
        "except ImportError:",
        "    HAS_LZMA = False",
        "if TYPE_CHECKING:",
        "    CHECK_ONLY = 1",
        "elif sys.platform == 'win32':",
        "    PATH_SEP = ';'",
        "else:",
        "    PATH_SEP = ':'",
        "with open('v') as f:",
        "    RAW_VERSION = f.read()",
        "",
      ].join("\n");
      expect(await namesOf(source)).toEqual(
        [3, 5, 7, 9, 11, 13].map((line) => `${line} naming.constant SCREAMING_SNAKE`),
      );
    });

    it("keeps class-body, function-local and loop-body caps names as variables", async () => {
      const source = [
        "class Config:",
        "    DEFAULT_PORT = 8080",
        "    if DEBUG_MODE:",
        "        TRACE_LEVEL = 2",
        "def run():",
        "    try:",
        "        LOCAL_MAX = 3",
        "    except ValueError:",
        "        LOCAL_MAX = 0",
        "for item in items:",
        "    LAST_ITEM = item",
        "",
      ].join("\n");
      expect(await namesOf(source)).toEqual(
        [2, 4, 7, 9, 11].map((line) => `${line} naming.variable SCREAMING_SNAKE`),
      );
    });

    it("leaves non-constant module-level names classified as before", async () => {
      const source = 'user_name = "a"\nUserId = int\n__all__ = ["x"]\nA_B, C_D = 1, 2\n';
      expect(await namesOf(source)).toEqual([
        "1 naming.variable snake_case",
        "2 naming.variable PascalCase",
      ]);
    });
  });

  describe("single-word capitals", () => {
    async function namesOf(source: string, file: string, language: string): Promise<string[]> {
      const parsed = await parseFile(source, file, language);
      return extractor
        .extract(parsed)
        .filter((o) => o.type === "naming.constant" || o.type === "naming.variable")
        .map((o) => `${o.line} ${o.type} ${o.value}`);
    }

    it("classifies a Python module-level single capitalised word as a constant, but not one letter", async () => {
      const source = [
        "DEBUG = True",
        "HEADERS: Dict[str, str] = {}",
        'T = TypeVar("T")',
        'P = ParamSpec("P")',
        "class Option:",
        "    TYPES = ()",
        "",
      ].join("\n");
      expect(await namesOf(source, "snippet.py", "python")).toEqual([
        "1 naming.constant SCREAMING_SNAKE",
        "2 naming.constant SCREAMING_SNAKE",
        "3 naming.variable PascalCase",
        "4 naming.variable PascalCase",
        "6 naming.variable PascalCase",
      ]);
    });

    it("classifies a TypeScript const single capitalised word as a constant, but not one letter or a let", async () => {
      const source = [
        'export const VERSION = "1.0.0";',
        "const K = 1;",
        "let DEBUG = true;",
        "function limit() {",
        "  const MAX = 3;",
        "}",
        "",
      ].join("\n");
      expect(await namesOf(source, "snippet.ts", "typescript")).toEqual([
        "1 naming.constant SCREAMING_SNAKE",
        "2 naming.variable PascalCase",
        "3 naming.variable PascalCase",
        "5 naming.constant SCREAMING_SNAKE",
      ]);
    });
  });
});
