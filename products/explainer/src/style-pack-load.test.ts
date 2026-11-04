import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";
import { stylePack } from "./profile-fixtures.test-helpers.js";
import { loadStylePacks, loadStyleTokens, StylePackError, stylePackCss, stylePackFor, stylePackSha, UnknownStylePackError } from "./style-pack-load.js";
import type { StylePack } from "./style-pack-schema.js";

/** A doctrine dir holding the shipped token pin and the given packs. */
function writePacks(...packs: StylePack[]): string {
  const dir = mkdtempSync(join(tmpdir(), "style-packs-"));
  mkdirSync(join(dir, "style-packs"));
  copyFileSync(join(DEFAULT_DOCTRINE_DIR, "style-tokens.json"), join(dir, "style-tokens.json"));
  for (const pack of packs) writeFileSync(join(dir, "style-packs", `${pack.id}.yaml`), stringify(pack));
  return dir;
}

const withToken = (slot: keyof StylePack["tokens"], token: string): StylePack => {
  const pack = stylePack("probe");
  return { ...pack, tokens: { ...pack.tokens, [slot]: token } };
};

describe("loadStylePacks", () => {
  it("loads three or four shipped packs, each naming only pinned tokens", () => {
    const packs = loadStylePacks();
    const known = loadStyleTokens();

    expect(packs.size).toBeGreaterThanOrEqual(3);
    expect(packs.size).toBeLessThanOrEqual(4);
    for (const pack of packs.values()) expect(Object.values(pack.tokens).filter((token) => !known.has(token))).toEqual([]);
  });

  it("rejects a pack that names a token tokens.css does not have", () => {
    const dir = writePacks(withToken("accent", "color-brand-tertiary"));

    expect(() => loadStylePacks(dir)).toThrow(StylePackError);
    expect(() => loadStylePacks(dir)).toThrow(/accent names unknown token color-brand-tertiary/);
  });

  it("rejects a slot holding the wrong kind of token", () => {
    const dir = writePacks(withToken("ease", "duration-slow"));

    expect(() => loadStylePacks(dir)).toThrow(/ease takes a token from ease-, not duration-slow/);
  });

  it("rejects a pack that names a channel whose look it would copy", () => {
    const dir = writePacks({ ...stylePack("probe"), feel: "Dark ground and blue arrows, like 3Blue1Brown." });

    expect(() => loadStylePacks(dir)).toThrow(/names 3blue1brown/);
  });

  it("loads a sound pack from another dir", () => {
    expect([...loadStylePacks(writePacks(stylePack("probe"))).keys()]).toEqual(["probe"]);
  });
});

describe("stylePackFor", () => {
  it("rejects an unknown pack, naming the known ones", () => {
    const packs = new Map([["plain", stylePack("plain")]]);

    expect(() => stylePackFor(packs, "loud")).toThrow(UnknownStylePackError);
    expect(() => stylePackFor(packs, "loud")).toThrow(/known: plain/);
  });
});

describe("a pack's render settings", () => {
  it("maps each slot to its token as a CSS custom property", () => {
    expect(stylePackCss(stylePack("plain"))).toContain("--pack-text-muted: var(--color-text-secondary);");
  });

  it("hashes the pack's content, so one changed token changes the hash", () => {
    expect(stylePackSha(withToken("lift", "lift-3"))).not.toBe(stylePackSha(stylePack("probe")));
  });
});
