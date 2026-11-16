import { afterAll } from "vitest";
import { drainScheduler } from "./drain-scheduler.js";

// Console files share one module graph per fork (isolate:false), so a React task one jsdom file leaves queued runs in
// whichever file comes next. Draining here covers every jsdom file, whatever its own cleanup does.
if (typeof document !== "undefined") afterAll(() => drainScheduler());
