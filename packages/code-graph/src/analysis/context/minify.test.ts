import { afterEach, describe, expect, it, vi } from "vitest";
import { Tree } from "web-tree-sitter";
import { importMarker, minifySource, originalLine } from "./minify.js";
import { FIXTURES, PY_CLASS, PY_ONLY_IMPORTS, TS_MODULE, TS_NO_IMPORTS, TSX_COMPONENT } from "./minify.fixtures.js";

const outputLines = (text: string): string[] => text.replace(/\n$/, "").split("\n");
const isMarker = (line: string): boolean => /^(\/\/|#) … \d+ imports?$/.test(line);
const indent = (line: string): string => /^\s*/.exec(line)?.[0] ?? "";
const COMMENT = /^\s*(\/\/.*|#.*|\/\*.*\*\/|\{\/\*.*\*\/\})?\s*$/;

/**
 * The one contiguous slice of `source` that `line` lacks, found by common prefix
 * and suffix. Where the slice was, `line` may hold one space that keeps two
 * tokens apart; anything else it holds there is a mismatch.
 */
function droppedSlice(source: string, line: string): string | null {
  let prefix = 0;
  while (prefix < line.length && line[prefix] === source[prefix]) prefix++;
  let suffix = 0;
  const room = Math.min(line.length, source.length) - prefix;
  while (suffix < room && line.at(-1 - suffix) === source.at(-1 - suffix)) suffix++;
  const inserted = line.slice(prefix, line.length - suffix);
  return inserted === "" || inserted === " " ? source.slice(prefix, source.length - suffix) : null;
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
        "  const kind = typeof path;",
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

  it.each([
    ["typeof/**/x;", "typeof x;"],
    ["a +/**/+b;", "a + +b;"],
    ["return/* c */x;", "return x;"],
    ["f(/* why */x);", "f(x);"],
  ])("puts one space where %j held a comment between two tokens, none beside a delimiter", async (code, kept) => {
    const result = await minifySource(`function f(x) {\n  ${code}\n}\n`, "typescript");

    expect(outputLines(result.text)[1]).toBe(`  ${kept}`);
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

  it("puts one space where a `{/* */}` sat between two words of JSX text", async () => {
    const result = await minifySource("const b = <b>one{/* c */}two</b>;\n", "tsx");

    expect(result.text).toBe("const b = <b>one two</b>;\n");
  });

  it("adds no space where a `{/* */}` sat between two elements", async () => {
    const result = await minifySource("const b = <a><b>x</b>{/*c*/}<i>y</i></a>;\n", "tsx");

    expect(result.text).toBe("const b = <a><b>x</b><i>y</i></a>;\n");
  });

  it("adds no space where a `{/* */}` was the only child of a fragment", async () => {
    const result = await minifySource("const b = <>{/*c*/}</>;\n", "tsx");

    expect(result.text).toBe("const b = <></>;\n");
  });

  it("still puts one space between two identifiers when a plain comment is cut", async () => {
    const result = await minifySource("const x = typeof/*c*/y;\n", "typescript");

    expect(result.text).toBe("const x = typeof y;\n");
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

  it("keeps a docstring that is a class or function body's only statement, so the suite is not empty", async () => {
    const source = "class MessageError(Exception):\n    \"\"\"Base class for errors.\"\"\"\n\n\ndef stub():\n    '''Not yet.'''  # todo\n";

    const result = await minifySource(source, "python");

    expect(result.text).toBe("class MessageError(Exception):\n    \"\"\"Base class for errors.\"\"\"\n\ndef stub():\n    '''Not yet.'''\n");
    expect(result.lineMap).toEqual([1, 2, 3, 5, 6]);
  });

  it("keeps a docstring that shares its line with the next statement, leaving no stray `;`", async () => {
    const source = "def f():\n    \"\"\"doc\"\"\"; x = 1\n    return x\n";

    const result = await minifySource(source, "python");

    expect(result.text).toBe(source);
  });

  it("drops a docstring's trailing `;` with it, leaving no bare `;` row", async () => {
    const result = await minifySource("def f():\n    \"\"\"doc\"\"\";\n    return 1\n", "python");

    expect(result.text).toBe("def f():\n    return 1\n");
  });

  it("keeps a module docstring's line out of the marker when an import shares it", async () => {
    const source = "\"\"\"doc\"\"\"; import os\nimport sys\nimport re\n\nx = 1\n";

    const result = await minifySource(source, "python");

    expect(result).toEqual({ text: "\"\"\"doc\"\"\"; import os\n# … 2 imports\n\nx = 1\n", lineMap: [1, 2, 4, 5] });
  });

  it("keeps an import that shares its line with code out of the marker", async () => {
    const result = await minifySource("import os\nimport sys; x = 1\n", "python");

    expect(result).toEqual({ text: "# … 1 import\nimport sys; x = 1\n", lineMap: [1, 2] });
  });
});

describe("minifySource tree lifetime", () => {
  afterEach(() => vi.restoreAllMocks());

  it("deletes the parse tree of every call, so repeated calls do not grow WASM memory", async () => {
    const deleted = vi.spyOn(Tree.prototype, "delete");

    for (const fixture of FIXTURES) await minifySource(fixture.source, fixture.language);

    expect(deleted).toHaveBeenCalledTimes(FIXTURES.length);
  });
});

describe("minifySource on other languages", () => {
  it("returns the text unchanged with an identity line map", async () => {
    const source = "fn main() { // rust\n}\n";

    const result = await minifySource(source, "rust");

    expect(result).toEqual({ text: source, lineMap: [1, 2] });
  });

  it("maps empty text to no lines", async () => {
    expect(await minifySource("", "rust")).toEqual({ text: "", lineMap: [] });
  });
});

describe("importMarker", () => {
  it("uses the language's line comment and a singular for one import", () => {
    expect(importMarker(1, "tsx")).toBe("// … 1 import");
    expect(importMarker(4, "python")).toBe("# … 4 imports");
  });
});
