import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDist } from "./dist-check.mjs";

const RNW_STYLE = '<style id="react-native-stylesheet">.r-flex-13awgt0{flex:1}</style>';
const page = (head: string, body: string) =>
  `<!doctype html><html><head>${head}</head><body><div id="root">${body}</div></body></html>`;
const GOOD_PAGE = page(RNW_STYLE, '<header role="banner">TITAN PLATFORM</header>');

let site: string;

function fixtureSite(files: Record<string, string>): string {
  site = mkdtempSync(join(tmpdir(), "docs-dist-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(site, path, ".."), { recursive: true });
    writeFileSync(join(site, path), text);
  }
  return site;
}

afterEach(() => rmSync(site, { recursive: true, force: true }));

describe("checking a prerendered site", () => {
  it("passes a site whose every page was filled in", () => {
    const dir = fixtureSite({ "index.html": GOOD_PAGE, "guides/index.html": GOOD_PAGE, "assets/app.js": "" });

    expect(checkDist(dir)).toEqual([]);
  });

  it("fails a page whose app markup was never replaced", () => {
    const dir = fixtureSite({ "index.html": GOOD_PAGE, "guides/index.html": page(RNW_STYLE, "<!--app-html-->") });

    expect(checkDist(dir)).toEqual(["guides/index.html still holds <!--app-html-->"]);
  });

  it("fails a page whose head placeholder was never replaced", () => {
    const dir = fixtureSite({ "index.html": page("<!--app-head-->", "<p>body</p>") });

    expect(checkDist(dir)).toEqual([
      "index.html still holds <!--app-head-->",
      "index.html has no react-native-web stylesheet",
    ]);
  });

  it("fails a site with no root page", () => {
    const dir = fixtureSite({ "guides/index.html": GOOD_PAGE });

    expect(checkDist(dir)).toEqual(["index.html is missing"]);
  });
});
