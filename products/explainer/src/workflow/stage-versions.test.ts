import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CACHED_STAGES } from "./records.js";
import { STAGE_VERSIONS, StageConfigSchema, stageKey, type StageSpec } from "./stage-spec.js";

const synthetic = (stage: StageSpec["stage"]) => ({ stage, inputs: { facts: "f0" }, config: StageConfigSchema.parse({}), sample: 0 });

describe("STAGE_VERSIONS", () => {
  it("keeps every stage's cache key unchanged by the reformat", () => {
    const keys = Object.fromEntries(CACHED_STAGES.map((stage) => [stage, stageKey(synthetic(stage))]));

    expect(keys).toMatchInlineSnapshot(`
      {
        "audition": "2c839d225b3522ce6c977e93a7e9b2c3bf18c4e7121f72126ebec97454d71204",
        "eval": "7966c11b5c6721387beb77a8444d8fe6981cdb76702794555aff4cb26e5e564a",
        "gather": "0c0370564aa84e9b65e805a79cf1bc71f918c203c5889015d84b9ed2754f7908",
        "qa": "eec53b8c878a5f869c91038496799036517e2907769568ac43828744f83b9283",
        "render": "73792e3b248234a26a33865a1ab902335fa02a660d30b63b80119924798b44d3",
        "resolve": "e1c29f1273034fdb3a15937a9103d7f5c14671f60bcfa0a4bfc1154d2dd379da",
        "rewrite": "31d6838414066fef9c2fc6704962ef6ad0649439504b99a6375acdb7b358a331",
        "script": "6535711d050adc2fa5c44bc901309c352e705a5f2abe00b312d6ee7b647182ce",
        "sheets": "d98f4f8ba6e25148fbbfd7518bea71539b52359e2f8786c1c357717fbb3e1573",
        "tts": "0c29a2566241392d932961c1cd0efa87eabe7805284d52d97b408f224a6cd6dd",
      }
    `);
  });

  it("keeps one stage per line so a version bump is a one-line diff", () => {
    const source = readFileSync(new URL("./stage-spec.ts", import.meta.url), "utf8");

    const body = /export const STAGE_VERSIONS[^=]*= \{\n([\s\S]*?)\n\};/.exec(source)?.[1] ?? "";
    const lines = body.split("\n");

    expect(lines).toHaveLength(Object.keys(STAGE_VERSIONS).length);
    for (const line of lines) expect(line).toMatch(/^ {2}\w+: "[^"]+",$/);
  });
});
