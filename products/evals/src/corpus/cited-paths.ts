const EXTENSIONS = "ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|yml|yaml|sql|sh|css|scss|html|py|toml|txt";
/** `path/to/file.ts`, `file.ts:12` or `file.ts:12-30`, bounded so a sentence's words are not read as paths. */
const FILE_TOKEN = new RegExp(`(?<![\\w/.@-])((?:[\\w@.-]+/)*[\\w@-][\\w@.-]*\\.(?:${EXTENSIONS}))(?::\\d+(?:-\\d+)?)?(?![\\w/])`, "g");
/** Inside backticks a path needs no known extension: `.github/CODEOWNERS`, `src/agents/seats/`. */
const BACKTICK_PATH = /`([\w@.-]*\/[\w@./-]*)`/g;

const tidy = (path: string): string => path.replace(/^\.\//, "").replace(/:\d+(?:-\d+)?$/, "");

/** The repo paths a FIX_FIRST review names, from its own text; URLs are not paths. */
export function citedPaths(text: string): string[] {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, " ");
  const found = [...withoutUrls.matchAll(FILE_TOKEN)].map((match) => match[1] ?? "");
  const ticked = [...withoutUrls.matchAll(BACKTICK_PATH)].map((match) => match[1] ?? "");
  return [...new Set([...found, ...ticked].map(tidy).filter((path) => path !== "" && path !== "/"))].sort();
}

/** A review may name a file by its tail (`in-flight-read.ts`) or a directory (`src/agents/`); both count as citing the full path. */
export function citesPath(cited: string, changed: string): boolean {
  if (cited.endsWith("/")) return changed.startsWith(cited) || changed.includes(`/${cited}`);
  return changed === cited || changed.endsWith(`/${cited}`);
}
