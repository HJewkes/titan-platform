import "@titan-design/react-ui/theme/global.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RpcProvider, pageDataSource, readEmbeddedSnapshot, type QuerySettled } from "@titan-design/react-app";
import { App } from "./App.js";
import { RouteTrackerProvider, postReport, createPerfSink, createRouteTracker, queryRow, startReporting, trackCalls } from "./data/perf.js";
import { AnswerSourceProvider } from "./data/submit.js";
import { createWaitTracker, trackWaitCalls } from "./data/waits.js";
import { WaitTrackerProvider } from "./shell/Loading.js";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

const page = pageDataSource();
// An exported page has no daemon to report to.
const reporting = !readEmbeddedSnapshot();
const sink = createPerfSink(postReport);
const tracker = createRouteTracker({ emit: sink.add });
const waits = createWaitTracker({ emit: sink.add });
if (reporting) startReporting(sink);
const routed = reporting ? trackCalls(page, tracker) : page;
const source = reporting ? trackWaitCalls(routed, waits, null) : page;
const answers = reporting ? trackWaitCalls(routed, waits, { emit: sink.add }) : page;
const onSettle = reporting ? (settled: QuerySettled): void => sink.add(queryRow(settled)) : undefined;

createRoot(root).render(
  <StrictMode>
    <RouteTrackerProvider value={reporting ? tracker : null}>
      <WaitTrackerProvider value={reporting ? waits : null}>
        <RpcProvider source={source} gcMs={60_000} onSettle={onSettle}>
          <AnswerSourceProvider value={readEmbeddedSnapshot() ? null : answers}>
            <App />
          </AnswerSourceProvider>
        </RpcProvider>
      </WaitTrackerProvider>
    </RouteTrackerProvider>
  </StrictMode>,
);
