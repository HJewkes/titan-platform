import type { MinifyLanguage } from "./minify.js";

export interface MinifyFixture {
  name: string;
  language: MinifyLanguage;
  source: string;
}

const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

export const TS_MODULE = lines(
  "#!/usr/bin/env node",
  "// Licence header.",
  "import type { Config } from \"./config.js\";",
  "import \"./polyfill.js\";",
  "// a comment between imports",
  "import { readFile } from \"node:fs/promises\";",
  "",
  "export { helper } from \"./helper.js\";",
  "",
  "",
  "/**",
  " * Loads the config.",
  " */",
  "export async function load(path: string): Promise<Config> {   ",
  "  const url = \"https://example.test/a\"; // trailing note",
  "  const glob = `/* not a comment */ ${path} // still text`;",
  "  /* block",
  "     comment */",
  "  return JSON.parse(await readFile(path, \"utf8\")) as Config;",
  "}",
);

export const TSX_COMPONENT = lines(
  "import { useState } from \"react\";",
  "",
  "export function Counter(): JSX.Element {",
  "  const [n, setN] = useState(0); // state",
  "  return (",
  "    <div className=\"counter\">",
  "      {/* the visible count */}",
  "      <span>{n /* inline */}</span>",
  "      {/*",
  "        multi-line JSX comment",
  "      */}",
  "      <a href=\"https://example.test/#top\">top</a>",
  "    </div>",
  "  );",
  "}",
);

export const PY_CLASS = lines(
  "#!/usr/bin/env python3",
  "\"\"\"Module docstring.\"\"\"",
  "from __future__ import annotations",
  "",
  "import os  # stdlib",
  "from typing import Any",
  "",
  "",
  "",
  "class Store:",
  "    \"\"\"Holds rows.",
  "",
  "    Spans lines.",
  "    \"\"\"",
  "",
  "    def get(self, key: str) -> Any:",
  "        '''Return the row for key.'''",
  "        # look it up",
  "        url = f\"http://example.test/#{key}\"  # anchor",
  "        query = \"\"\"",
  "            SELECT * -- # not a comment",
  "",
  "",
  "            FROM rows   ",
  "        \"\"\"",
  "        return os.environ.get(url, query)",
);

export const TS_NO_IMPORTS = lines(
  "const a = 1; // one",
  "",
  "",
  "",
  "function twice(x: number): number {",
  "  return x * 2;",
  "}",
);

export const PY_ONLY_IMPORTS = lines(
  "# header comment",
  "import os",
  "# between",
  "from sys import argv",
);

export const FIXTURES: readonly MinifyFixture[] = [
  { name: "TypeScript module", language: "typescript", source: TS_MODULE },
  { name: "TSX component", language: "tsx", source: TSX_COMPONENT },
  { name: "Python class with method docstrings", language: "python", source: PY_CLASS },
  { name: "TypeScript file with no imports", language: "typescript", source: TS_NO_IMPORTS },
  { name: "Python file of only imports and comments", language: "python", source: PY_ONLY_IMPORTS },
];
