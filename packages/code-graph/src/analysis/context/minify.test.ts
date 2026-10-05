import { describe, expect, it } from "vitest";
import { importMarker, minifySource, originalLine } from "./minify.js";
import { FIXTURES, PY_CLASS, PY_ONLY_IMPORTS, TS_MODULE, TS_NO_IMPORTS, TSX_COMPONENT } from "./minify.fixtures.js";

const outputLines = (text: string): string[] => text.replace(/\n$/, "").split("\n");
const isMarker = (line: string): boolean => /^(\/\/|#) … \d+ imports?$/.test(line);
const indent = (line: string): string => /^\s*/.exec(line)?.[0] ?? "";
const COMMENT = /^\s*(\/\/.*|#.*|\/\*.*\*\/|\{\/\*.*\*\/\})?\s*$/;

/** The one contiguous slice of `source` that `line` lacks, found by common prefix and suffix. */
function droppedSlice(source: string, line: string): string | null {
  let prefix = 0;
  while (prefix < line.length && line[prefix] === source[prefix]) prefix++;
  const suffix = line.length - prefix;
  if (source.slice(source.length - suffix) !== line.slice(prefix)) return null;
  return source.slice(prefix, source.length - suffix);
}

describe("minifySource keeps every surviving line byte-identical (C-90 A)", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: each kept line is its original line minus one comment and trailing whitespace`, async () => {
      const original = fixture.source.split("\n");
      const result = await minifySource(fixture.source, fixture.language);

      outputLines(result.text).forEach((line, i) => {
        if (isMarker(line)) return;
        const source = original[(result.lineMap[i] ?? 0) - 1] ?? "";
        if (line === "") return expect(source.trim()).toBe("");
        expect(indent(line), `line ${i + 1} indentation`).toBe(indent(source));
        const dropped = droppedSlice(source, line);
        expect(dropped !== null && COMMENT.test(dropped), `line ${i + 1} dropped ${JSON.stringify(dropped)}`).toBe(true);
      });
    });

    it(`${fixture.name}: the line map has one entry per output line, ascending`, async () => {
      const result = await minifySource(fixture.source, fixture.language);

      expect(result.lineMap).toHaveLength(outputLines(result.text).length);
      expect([...result.lineMap].sort((a, b) => a - b)).toEqual(result.lineMap);
      expect(new Set(result.lineMap).size).toBe(result.lineMap.length);
    });
  }
});

describe("minifySource on TypeScript", () => {
  it("drops JSDoc, line and block comments, keeps re-exports and replaces the import block", async () => {
    const result = await minifySource(TS_MODULE, "typescript");

    expect(result.text).toBe(
      [
        "// … 3 imports",
        "",
        "export { helper } from \"./helper.js\";",
        "",
        "export async function load(path: string): Promise<Config> {",
        "  const url = \"https://example.test/a\";",
        "  const glob = `/* not a comment */ ${path} // still text`;",
        "  return JSON.parse(await readFile(path, \"utf8\")) as Config;",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("maps the marker to the first import line and each kept line back to its source line", async () => {
    const result = await minifySource(TS_MODULE, "typescript");
    const original = TS_MODULE.split("\n");

    expect(originalLine(result, 1)).toBe(3);
    expect(original[(originalLine(result, 7) ?? 0) - 1]).toContain("`/* not a comment */");
    expect(originalLine(result, 99)).toBeUndefined();
  });

  it("keeps a template literal's trailing whitespace and blank lines, which are string content", async () => {
    const source = "const t = `a  \n\n\nb`;   \n";

    const result = await minifySource(source, "typescript");

    expect(result.text).toBe("const t = `a  \n\n\nb`;\n");
    expect(result.lineMap).toEqual([1, 2, 3, 4]);
  });

  it("removes a mid-line block comment and keeps the code around it", async () => {
    const result = await minifySource("call(/* why */ arg);\n", "typescript");

    expect(result.text).toBe("call( arg);\n");
  });

  it("collapses blank runs in a file with no imports and emits no marker", async () => {
    const result = await minifySource(TS_NO_IMPORTS, "typescript");

    expect(result.text).toBe("const a = 1;\n\nfunction twice(x: number): number {\n  return x * 2;\n}\n");
    expect(result.lineMap).toEqual([1, 2, 5, 6, 7]);
  });
});

describe("minifySource on TSX", () => {
  it("drops `{/* */}` JSX comments whole, single and multi-line, and keeps `#` inside attributes", async () => {
    const result = await minifySource(TSX_COMPONENT, "tsx");

    expect(outputLines(result.text)).toEqual([
      "// … 1 import",
      "",
      "export function Counter(): JSX.Element {",
      "  const [n, setN] = useState(0);",
      "  return (",
      "    <div className=\"counter\">",
      "      <span>{n }</span>",
      "      <a href=\"https://example.test/#top\">top</a>",
      "    </div>",
      "  );",
      "}",
    ]);
    expect(result.lineMap).toEqual([1, 2, 3, 4, 5, 6, 8, 12, 13, 14, 15]);
  });
});

describe("minifySource on Python", () => {
  it("drops module, class and method docstrings and comments, keeping f-strings and other triple-quoted strings", async () => {
    const result = await minifySource(PY_CLASS, "python");

    expect(outputLines(result.text)).toEqual([
      "# … 3 imports",
      "",
      "class Store:",
      "",
      "    def get(self, key: str) -> Any:",
      "        url = f\"http://example.test/#{key}\"",
      "        query = \"\"\"",
      "            SELECT * -- # not a comment",
      "",
      "",
      "            FROM rows   ",
      "        \"\"\"",
      "        return os.environ.get(url, query)",
    ]);
    expect(result.lineMap).toEqual([3, 7, 10, 15, 16, 19, 20, 21, 22, 23, 24, 25, 26]);
  });

  it("reduces a file of only imports and comments to the marker", async () => {
    const result = await minifySource(PY_ONLY_IMPORTS, "python");

    expect(result).toEqual({ text: "# … 2 imports\n", lineMap: [2] });
  });

  it("keeps an import that shares its line with code out of the marker", async () => {
    const result = await minifySource("import os\nimport sys; x = 1\n", "python");

    expect(result).toEqual({ text: "# … 1 import\nimport sys; x = 1\n", lineMap: [1, 2] });
  });
});

describe("minifySource on other languages", () => {
  it("returns the text unchanged with an identity line map", async () => {
    const source = "fn main() { // rust\n}\n";

    const result = await minifySource(source, "rust");

    expect(result).toEqual({ text: source, lineMap: [1, 2] });
  });
});

describe("importMarker", () => {
  it("uses the language's line comment and a singular for one import", () => {
    expect(importMarker(1, "tsx")).toBe("// … 1 import");
    expect(importMarker(4, "python")).toBe("# … 4 imports");
  });
});
