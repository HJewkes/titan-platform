// Serves the built single-file app through mountStaticApp next to the read API: `pnpm --filter code-report serve`.
import { existsSync } from "node:fs";
import path from "node:path";
import { closeOnSignal, startReportDaemon } from "./daemon.js";
import { DIST_DIR } from "./paths.js";

const page = path.join(DIST_DIR, "index.html");
if (!existsSync(page)) console.warn(`${page} is missing; run \`pnpm --filter code-report build\` (the daemon serves a "not built" page until then)`);
const handle = await startReportDaemon({ staticRoot: page });
console.log(`code report: http://127.0.0.1:${handle.port}/ (pid ${process.pid})`);
closeOnSignal(handle);
