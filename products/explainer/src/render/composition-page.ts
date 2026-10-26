import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { serveTree } from "../qa/serve-tree.js";
import { sha256 } from "../workflow/artifacts.js";

/** Where the page's sources sit in the package: its Vite root, plus files outside it that its build reads. */
export interface PageSource {
  root: string;
  extra: readonly string[];
}

export interface BuiltPage {
  dir: string;
  /** The built tree's sha, the `page` sha a render manifest records. */
  sha: string;
}

export type PageBuild = (outDir: string) => Promise<void>;

const isTestFile = (name: string): boolean => /\.test(-helpers)?\.tsx?$/.test(name);

function treeFiles(dir: string, skip: (name: string) => boolean = () => false): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !skip(entry.name))
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

const listingSha = (lines: readonly string[]): string => sha256(`${lines.join("\n")}\n`);

/** The sha of every file under `dir` by relative path, so equal trees give equal shas wherever they sit. */
export function treeSha(dir: string): string {
  return listingSha(treeFiles(dir).map((file) => `${sha256(readFileSync(path.join(dir, file)))}  ${file}`));
}

/** The sha of what a page build reads; tests are left out, so editing one does not rebuild the page. */
export function pageSourceSha({ root, extra }: PageSource): string {
  const own = treeFiles(root, isTestFile).map((file) => `${sha256(readFileSync(path.join(root, file)))}  ${file}`);
  const outside = extra.map((file) => `${sha256(readFileSync(file))}  extra:${path.basename(file)}`);
  return listingSha([...own, ...outside]);
}

/**
 * The page built once per source sha into `<cacheRoot>/<sha>`. A build lands under a temporary name and is renamed
 * into place, so an interrupted build is never taken for a finished one.
 */
export async function cachedPage(source: PageSource, cacheRoot: string, build: PageBuild): Promise<BuiltPage> {
  const dir = path.join(cacheRoot, pageSourceSha(source));
  if (!existsSync(dir)) {
    const staging = `${dir}.building-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    try {
      await build(staging);
      if (!existsSync(dir)) renameSync(staging, dir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return { dir, sha: treeSha(dir) };
}

export interface ServedPage {
  /** The page's URL with `?timeline=` pointing at the served timeline.json. */
  url: string;
  close(): Promise<void>;
}

/** Serves the built page at /page/ and the timeline at /timeline.json on loopback, linked into one throwaway root. */
export async function servePage(pageDir: string, timelineFile: string): Promise<ServedPage> {
  const root = mkdtempSync(path.join(path.dirname(timelineFile), ".serve-"));
  symlinkSync(path.resolve(pageDir), path.join(root, "page"), "dir");
  symlinkSync(path.resolve(timelineFile), path.join(root, "timeline.json"));
  const served = await serveTree(root);
  const close = async () => {
    await served.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { url: `${served.origin}/page/index.html?timeline=/timeline.json`, close };
}
