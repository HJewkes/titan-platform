import { render, type RenderResult } from "@testing-library/react";
import { RpcProvider, SNAPSHOT_ELEMENT_ID } from "@titan-design/react-app";
import type { Snapshot } from "@titan-design/rpc-client";
import { App } from "../App.js";
import { reportDataSource } from "../data/source.js";

/** Renders the whole app at a route, reading the snapshot from the page the way an exported report does. */
export function renderReport(hash: string, snapshot: Snapshot): RenderResult {
  document.getElementById(SNAPSHOT_ELEMENT_ID)?.remove();
  const element = document.createElement("script");
  element.type = "application/json";
  element.id = SNAPSHOT_ELEMENT_ID;
  element.textContent = JSON.stringify(snapshot);
  document.head.append(element);
  window.location.hash = hash;
  return render(
    <RpcProvider source={reportDataSource()}>
      <App />
    </RpcProvider>,
  );
}
