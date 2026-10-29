import { launch, openCapturePage } from "@titan-design/frame-capture";
import { formatRow, type OverflowRow } from "../composition/beats/stage/overflow-row.js";

interface ScanBeat {
  id: string;
  startS: number;
  durationS: number;
}

export type StageFitScan = (pageUrl: string, timeline: { beats: readonly ScanBeat[] }, viewport: { width: number; height: number }) => Promise<OverflowRow[]>;

/** Twice a second through each beat, the capture's own moments being too many to seek before every render. */
const SCAN_HZ = 2;
/** The beat's last moment, when every element has landed and every figure has settled. */
const SETTLED_BEFORE_END_S = 0.05;

/** The moments the scan seeks: a 2 Hz sweep of each beat and the beat's settled end. */
export function scanMoments(beats: readonly ScanBeat[]): number[] {
  return beats.flatMap(({ startS, durationS }) => {
    const sweep = Array.from({ length: Math.ceil(durationS * SCAN_HZ) }, (_, k) => startS + k / SCAN_HZ);
    return [...sweep, startS + Math.max(0, durationS - SETTLED_BEFORE_END_S)];
  });
}

const reportUrl = (pageUrl: string): string => {
  const url = new URL(pageUrl);
  url.searchParams.set("stage-fit", "report");
  return url.toString();
};

/** Seeks the page in report mode through every beat and reads back each beat's overflow past the type floor, in beat order. */
export const chromiumStageFitScan: StageFitScan = async (pageUrl, timeline, viewport) => {
  const browser = await launch();
  try {
    const { page } = await openCapturePage(browser, reportUrl(pageUrl), viewport);
    for (const t of scanMoments(timeline.beats)) {
      await page.evaluate(async (seconds) => {
        window.__virtualTime.advanceTo(seconds * 1000);
        window.__titanMotion?.seek(seconds);
        await window.__titanMotion?.ready();
      }, t);
    }
    const rows = await page.evaluate(() => Object.values(window.__stageOverflows ?? {}));
    const order = new Map(timeline.beats.map((beat, i) => [beat.id, i]));
    return rows.sort((a, b) => (order.get(a.beat) ?? 0) - (order.get(b.beat) ?? 0));
  } finally {
    await browser.close();
  }
};

/** Thrown before any mix or frame: every beat still past its stage box at the type floor, one row each. */
export class StageOverflow extends Error {
  constructor(readonly rows: readonly OverflowRow[]) {
    super(`render: ${rows.length} ${rows.length === 1 ? "beat overflows" : "beats overflow"} the stage box at the 40 px type floor:\n${rows.map((row) => `  ${formatRow(row)}`).join("\n")}`);
    this.name = "StageOverflow";
  }
}
