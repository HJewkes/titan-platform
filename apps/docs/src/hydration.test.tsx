// @vitest-environment jsdom
import { TopBar } from "@titan-design/react-ui";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { DOCS_BRAND } from "./DocsShell.js";
import { render } from "./entry-server.js";
import { hydrate } from "./hydrate.js";

const NOON = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

let mounted: Root | undefined;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = undefined;
  document.body.innerHTML = "";
});

async function hydrateOver(serverHtml: string, client: ReactNode) {
  const container = document.createElement("div");
  container.innerHTML = serverHtml;
  document.body.append(container);
  const onRecoverableError = vi.fn();
  await act(async () => {
    mounted = hydrate(container, client, onRecoverableError);
  });
  return onRecoverableError;
}

describe("hydrating the prerendered docs root", () => {
  it("adopts the server markup without a recoverable error", async () => {
    const onRecoverableError = await hydrateOver(render("").html, <App route="" />);

    expect(onRecoverableError).not.toHaveBeenCalled();
  });

  it("reports a mismatch when the server rendered the clock an hour earlier", async () => {
    const server = renderToString(<TopBar brand={DOCS_BRAND} showClock time={NOON - HOUR} />);

    const onRecoverableError = await hydrateOver(server, <TopBar brand={DOCS_BRAND} showClock time={NOON} />);

    expect(onRecoverableError).toHaveBeenCalled();
  });
});
