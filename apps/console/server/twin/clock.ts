/** The instant every twin capture shows, half a minute past a minute so a one-second skew moves no minute-grained age. */
export const TWIN_NOW = Date.parse("2031-03-05T12:00:30.000Z");

/**
 * The second shot of each route runs its clock this much later. A page that shows only fixture data, or ages to the
 * minute, renders the same bytes; one that prints the clock itself does not, which is the leak the twin exists to catch.
 */
export const SECOND_SHOT_SKEW_MS = 1000;

/**
 * An init script that stops the page's clock at `nowMs` and seeds Math.random. Timers still run in real time, so the
 * app settles as it would live; only what it reads off the clock is held still. Self-contained, because Playwright
 * serialises it into the page.
 */
export function frozenClockScript(nowMs: number): string {
  return `(${String(installFrozenClock)})(${JSON.stringify(nowMs)})`;
}

function installFrozenClock(nowMs: number): void {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args: [] | [string | number | Date] | [number, number, ...number[]]) {
      if (args.length === 0) super(nowMs);
      else if (args.length === 1) super(args[0]);
      else super(...(args as [number, number]));
    }
    static override now(): number {
      return nowMs;
    }
  }
  Object.defineProperty(window, "Date", { value: FrozenDate, writable: true, configurable: true });
  let seed = 0x2f6b9d31;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
