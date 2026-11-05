#!/usr/bin/env node
// The F11 report over one clock's window (TP-3103 F6): an offline read of the event log, the serve log and the HJewkes
// rate sample. Nothing here runs in serve.
// usage: f11.mjs --db <factory.db> --log <serve log> --since <iso> --until <iso> --clock polling|webhook
//                [--rate <jsonl>] [--within-ms <n>] [--out <json>]
// Each serve-log record must lead with an ISO timestamp (`journalctl -o short-iso`, or serve.err.log piped through
// `ts`); a log with none is refused. The report's markdown goes to stdout.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { agreement, kindCensus } from "../src/event-log/agreement.ts";
import { f11Markdown, f11Report, unplacedLog } from "../src/event-log/f11-report.ts";
import { f11Window, readF11Window } from "../src/event-log/f11-window.ts";
import { ratePeaks } from "../src/github-api/rate-sample.ts";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    log: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    clock: { type: "string" },
    rate: { type: "string" },
    "within-ms": { type: "string" },
    out: { type: "string" },
  },
});

if (!values.db || !values.log || !values.since || !values.until || (values.clock !== "polling" && values.clock !== "webhook")) {
  console.error("usage: f11.mjs --db <path> --log <path> --since <iso> --until <iso> --clock polling|webhook [--rate <jsonl>] [--within-ms <n>] [--out <json>]");
  process.exit(2);
}

const window = f11Window(values.since, values.until);
const rate = values.rate ? readFileSync(values.rate, "utf8").split("\n").filter((text) => text.trim() !== "").map((text) => JSON.parse(text)) : [];
const report = f11Report(
  {
    clock: values.clock,
    window,
    rows: readF11Window(values.db, window),
    log: readFileSync(values.log, "utf8"),
    rate,
    ...(values["within-ms"] !== undefined && { withinMs: Number(values["within-ms"]) }),
  },
  { kindCensus, agreement, ratePeaks },
);
const problem = unplacedLog(report);
if (problem !== undefined) {
  console.error(problem);
  process.exit(1);
}
if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(f11Markdown(report));
