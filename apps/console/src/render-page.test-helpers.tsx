import type { ReactNode } from "react";
import { act, cleanup, render, type RenderResult } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { staticSource, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";
import { PAGES } from "./pages/index.js";
import { href, parseRoute, type Route } from "./router.js";

interface RenderPageOptions {
  /** Where the page sends answers; null, as on an exported snapshot page, sends nothing. */
  answers?: DataSource | null;
  /** Mounts the whole `<App>` at the route instead, for the file's routing test and any assertion that follows the hash. */
  inApp?: boolean;
}

const sourceOf = (data: Snapshot | DataSource): DataSource => ("call" in data ? data : staticSource({ snapshot: data }));

/**
 * Mounts one route's page in its Page shell, inside the providers `<App>` gets from main.tsx, without the
 * rail, top bar, footer or live invalidation. The route is fixed: a test that follows a hash change, or
 * asserts on what the shell draws, passes `inApp`.
 */
export function renderPage(data: Snapshot | DataSource, route: Route | string, { answers = null, inApp = false }: RenderPageOptions = {}): RenderResult {
  const at = typeof route === "string" ? parseRoute(route) : route;
  // A page that reads the route itself, as the pager does, sees the one it was given.
  window.location.hash = href(at);
  return render(
    <RpcProvider source={sourceOf(data)}>
      <AnswerSourceProvider value={answers}>{inApp ? <App /> : <RoutedPage route={at} />}</AnswerSourceProvider>
    </RpcProvider>,
  );
}

function RoutedPage({ route }: { route: Route }): ReactNode {
  const Page = PAGES[route.view];
  if (!Page) throw new Error(`no page is registered for ${route.view}`);
  return <Page route={route} />;
}

/**
 * Unmounts what `renderPage` mounted, then lets the macrotask a late snapshot resolution or React's scheduler queued
 * run inside `act`. Left pending, it fires after the file's jsdom is torn down and fails the run with
 * "window is not defined" (TP-4636).
 */
export async function unmountPages(): Promise<void> {
  cleanup();
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}
