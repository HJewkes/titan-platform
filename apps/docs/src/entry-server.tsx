import { renderToString } from "react-dom/server";
import { StyleSheet } from "react-native-web";
import { App, type Route } from "./App.js";

export { ROUTES } from "./App.js";

interface Rendered {
  /** The markup for the root element. */
  html: string;
  /** Tags for `<head>`: the react-native-web stylesheet the render produced. */
  head: string;
}

/**
 * One route's markup and the atomic rules react-native-web collected while rendering it. The sheet accumulates across
 * renders in one process, so each later page carries every earlier page's rules too.
 */
export function render(route: Route): Rendered {
  const html = renderToString(<App route={route} />);
  const sheet = StyleSheet.getSheet();
  return { html, head: `<style id="${sheet.id}">${sheet.textContent}</style>` };
}
