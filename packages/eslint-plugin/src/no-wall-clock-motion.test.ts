import { noWallClockMotion } from "./no-wall-clock-motion.js";
import { tsRuleTester } from "./test-fixtures.js";

function message(call: string): string {
  return `\`${call}\` reads the wall clock or an unseeded source, so a seek or a second render shows different frames. Derive motion from the beat's \`t\` or progress, or from a seeded generator, and never from real time.`;
}

const beat = "/repo/src/ui/beats/title.tsx";

tsRuleTester.run("no-wall-clock-motion", noWallClockMotion, {
  valid: [
    { name: "Date.now in a test file under ui/beats", code: "Date.now();", filename: "/repo/src/ui/beats/title.test.tsx" },
    { name: "Date.now in a spec file", code: "Date.now();", filename: "/repo/src/ui/beats/title.spec.ts" },
    { name: "Date.now in a __tests__ directory", code: "Date.now();", filename: "/repo/src/ui/beats/__tests__/clock.ts" },
    { name: "Date.now outside beat and motion code", code: "Date.now();", filename: "/repo/src/server/clock.ts" },
    { name: "a path that only resembles a beat directory", code: "Date.now();", filename: "/repo/src/ui/beatsheet/x.ts" },
    { name: "motion derived from the beat time", code: "const x = progress * 40;", filename: beat },
    { name: "a method named now on another object", code: "clock.now();", filename: beat },
    { name: "a local function named random", code: "random();", filename: beat },
    { name: "a seeded generator", code: "const r = rng();", filename: beat },
    { name: "a configured path replaces the default", code: "Date.now();", filename: beat, options: [{ paths: ["/anim/"] }] },
  ],
  invalid: [
    { name: "Date.now in ui/beats", code: "Date.now();", filename: beat, errors: [{ message: message("Date.now") }] },
    { name: "Date.now in a motion directory", code: "Date.now();", filename: "/repo/src/motion/tween.ts", errors: [{ message: message("Date.now") }] },
    { name: "performance.now", code: "performance.now();", filename: beat, errors: [{ message: message("performance.now") }] },
    { name: "Math.random", code: "Math.random();", filename: beat, errors: [{ message: message("Math.random") }] },
    { name: "setTimeout", code: "setTimeout(go, 100);", filename: beat, errors: [{ message: message("setTimeout") }] },
    { name: "setInterval", code: "setInterval(go, 100);", filename: beat, errors: [{ message: message("setInterval") }] },
    { name: "requestAnimationFrame", code: "requestAnimationFrame(go);", filename: beat, errors: [{ message: message("requestAnimationFrame") }] },
    { name: "a window-qualified timer", code: "window.setTimeout(go, 100);", filename: beat, errors: [{ message: message("setTimeout") }] },
    { name: "a globalThis-qualified Date.now", code: "globalThis.Date.now();", filename: beat, errors: [{ message: message("Date.now") }] },
    { name: "a computed method name", code: 'Date["now"]();', filename: beat, errors: [{ message: message("Date.now") }] },
    { name: "a Windows-style path", code: "Date.now();", filename: "C:\\repo\\src\\ui\\beats\\title.tsx", errors: [{ message: message("Date.now") }] },
    {
      name: "a configured path",
      code: "Date.now();",
      filename: "/repo/src/anim/x.ts",
      options: [{ paths: ["/anim/"] }],
      errors: [{ message: message("Date.now") }],
    },
  ],
});
