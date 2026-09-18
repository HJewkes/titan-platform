import * as path from "node:path";

const EXCLUDED_DIRS = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".next",
  "__generated__",
  ".git",
  ".claude",
  "coverage",
];

const EXCLUDED_PATTERNS = [
  /\.min\.[jt]sx?$/,
  /\.d\.ts$/,
  /\.map$/,
  /lock\.(json|yaml)$/,
  /pnpm-lock\.yaml$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
];

const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: [".ts", ".tsx"],
  javascript: [".js", ".jsx"],
  python: [".py"],
};

/**
 * True when a directory NAME should be pruned from a recursive source walk
 * (node_modules, dist, .git, …). File discovery already rejects files under
 * these via `shouldIncludeFile`, but a walker that recurses into them anyway
 * pays to `readdir` the entire tree (e.g. a multi-GB `node_modules`) only to
 * discard every file — so pruning at the directory level is a large speedup and
 * changes no output. Kept in sync with `EXCLUDED_DIRS`.
 */
export function isExcludedDir(dirName: string): boolean {
  return EXCLUDED_DIRS.includes(dirName);
}

export function shouldIncludeFile(
  filePath: string,
  languages: string[],
): boolean {
  const segments = filePath.split("/");
  if (segments.some((s) => EXCLUDED_DIRS.includes(s))) {
    return false;
  }

  if (EXCLUDED_PATTERNS.some((p) => p.test(filePath))) {
    return false;
  }

  const ext = path.extname(filePath);
  const allowedExtensions = languages.flatMap(
    (lang) => LANGUAGE_EXTENSIONS[lang] ?? [],
  );

  return allowedExtensions.includes(ext);
}

export function getLanguageFromPath(filePath: string): string | null {
  const ext = path.extname(filePath);
  for (const [language, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (extensions.includes(ext)) {
      return language;
    }
  }
  return null;
}
