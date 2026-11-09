import { describe, expect, it } from "vitest";
import * as packageRouter from "@titan-design/react-ui/visual-router";
// @ts-expect-error the pin script is plain ESM without type declarations
import { pinRouter } from "../scripts/pin-visual-router.mjs";
import { loadVisualRouter } from "./visual-router.js";

describe("the pinned visual router against the installed react-ui", () => {
  it("matches what the package's router answers, so a react-ui bump forces a re-pin", () => {
    const { source, ...pinned } = loadVisualRouter();
    const current = pinRouter(packageRouter, source.commit);

    expect(pinned).toEqual({ patterns: current.patterns, types: current.types });
  });
});
