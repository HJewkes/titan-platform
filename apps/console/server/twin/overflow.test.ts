import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { embedSnapshot } from "@titan-design/react-app";
import { PAGE_FILE } from "../paths.js";
import { measureOverflow } from "./capture.js";
import { TWIN_ROUTES } from "./routes.js";
import { twinSnapshot } from "./snapshot.js";

const BROWSER_TIMEOUT_MS = 180_000;

/** The narrowest phone the console promises to fit: an iPhone 12 to 15 held upright. */
const PHONE_390 = { width: 390, height: 844 };

describe("the console on a 390px phone", { timeout: BROWSER_TIMEOUT_MS }, () => {
  it("scrolls no twin route sideways", async () => {
    const html = embedSnapshot(await readFile(PAGE_FILE, "utf8"), await twinSnapshot());

    const overflow = await measureOverflow({ html, routes: TWIN_ROUTES, viewport: PHONE_390 });

    expect(overflow.filter((route) => route.overflowPx > 0)).toEqual([]);
  });
});
