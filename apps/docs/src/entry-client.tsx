import "@titan-design/react-ui/theme/global.css";
import "./styles.css";
import { App, ROUTES, type Route } from "./App.js";
import { hydrate } from "./hydrate.js";

declare global {
  interface Window {
    /** The route this page was prerendered for, written inline by scripts/prerender.mjs. */
    __ROUTE__?: string;
  }
}

function pageRoute(): Route {
  const route = ROUTES.find((r) => r === window.__ROUTE__);
  if (route === undefined) throw new Error(`this page names no known route: ${String(window.__ROUTE__)}`);
  return route;
}

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

// A mismatch makes React discard the server tree and render on the client; say so where a reviewer will look.
hydrate(root, <App route={pageRoute()} />, (error) => console.error("docs: hydration mismatch", error));
