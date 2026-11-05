import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { describeOverflow } from "./overflow-row.js";
import { overflowPx } from "./stageFit.js";

const STAGE = { w: 1920, h: 793 };

describe("stage overflow", () => {
  test("is zero on every side for content inside the stage", () => {
    const rows = [{ x: 192, y: 0, w: 1536, h: 400 }, { x: 192, y: 420, w: 1536, h: 373 }];

    const overflow = overflowPx(STAGE.w, STAGE.h, rows);

    assert.deepEqual(overflow, { top: 0, right: 0, bottom: 0, left: 0 });
  });

  test("splits a centred list that is too tall between top and bottom", () => {
    const list = [{ x: 192, y: -62, w: 1536, h: 918 }];

    const overflow = overflowPx(STAGE.w, STAGE.h, list);

    assert.deepEqual(overflow, { top: 62, right: 0, bottom: 63, left: 0 });
  });

  test("reports a value wider than the stage on the side it runs out of", () => {
    const value = [{ x: 192, y: 200, w: 1793, h: 184 }];

    const overflow = overflowPx(STAGE.w, STAGE.h, value);

    assert.equal(overflow.right, 65);
  });

  test("reports content left of the stage on the left side", () => {
    const value = [{ x: -40, y: 200, w: 600, h: 184 }];

    const overflow = overflowPx(STAGE.w, STAGE.h, value);

    assert.deepEqual(overflow, { top: 0, right: 0, bottom: 0, left: 40 });
  });

  test("ignores a 1 px rounding overhang", () => {
    const overhang = [{ x: 0, y: -1, w: 1921, h: 794 }];

    const overflow = overflowPx(STAGE.w, STAGE.h, overhang);

    assert.deepEqual(overflow, { top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe("overflow message", () => {
  test("names the beat, the worst side in px, and every side that overflows", () => {
    const message = describeOverflow("lanes-1", { top: 62, right: 0, bottom: 63, left: 0 });

    assert.equal(message, "lanes-1 overflows its stage box by 63 px (top 62, bottom 63)");
  });

  test("is undefined when the content fits", () => {
    const message = describeOverflow("stats-2", { top: 0, right: 0, bottom: 0, left: 0 });

    assert.equal(message, undefined);
  });
});
