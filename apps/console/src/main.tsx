import "@titan-design/react-ui/theme/global.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RpcProvider, pageDataSource, readEmbeddedSnapshot, type QuerySettled } from "@titan-design/react-app";
import { App } from "./App.js";
import { RouteTrackerProvider, postReport, createPerfSink, createRouteTracker, queryRow, startReporting, trackCalls } from "./data/perf.js";
import { AnswerSourceProvider } from "./data/submit.js";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

const page = pageDataSource();
// An exported page has no daemon to report to.
const reporting = !readEmbeddedSnapshot();
const sink = createPerfSink(postReport);
const tracker = createRouteTracker({ emit: sink.add });
if (reporting) startReporting(sink);
const source = reporting ? trackCalls(page, tracker) : page;
const onSettle = reporting ? (settled: QuerySettled): void => sink.add(queryRow(settled)) : undefined;

createRoot(root).render(
  <StrictMode>
    <RouteTrackerProvider value={reporting ? tracker : null}>
      <RpcProvider source={source} gcMs={60_000} onSettle={onSettle}>
        <AnswerSourceProvider value={readEmbeddedSnapshot() ? null : source}>
          <App />
        </AnswerSourceProvider>
      </RpcProvider>
    </RouteTrackerProvider>
  </StrictMode>,
);
