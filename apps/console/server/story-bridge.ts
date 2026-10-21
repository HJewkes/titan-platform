/**
 * The story bridge (TP-3793), served at `/__bridge.js` on the story origin and injected into each
 * stored build's `iframe.html`. It runs as the story, so it can read what the console page, on
 * another origin, cannot: whether Storybook rendered the story, and how tall it is. It posts
 * `ready`, `error` or `height` to `window.parent`, only ever to the page's own origin.
 *
 * The page names its origin as `?parent=`, and the bridge posts nothing unless that origin is one
 * of the console's own. Story code shares this origin and can forge any of these messages, so
 * nothing the page does with one may change an answer.
 *
 * It is plain ES5 in a string, not a compiled function, so what the browser runs is exactly what
 * the tests run.
 */

/** Marks every bridge message, so the page can tell them from a story's own postMessage traffic. */
export const BRIDGE_TAG = "titan-story";
export const BRIDGE_PATH = "/__bridge.js";
/** On the fast-fail page's bridge script tag: the bridge posts this as an `error` at once. */
export const BRIDGE_ERROR_ATTRIBUTE = "data-story-error";
/** As the harness's frame (review-harness `page/Frame.tsx`): a story that keeps resizing stops being measured. */
const MAX_HEIGHTS = 12;
/** The page gives up at 10 s; the bridge stops looking for Storybook's channel at the same point. */
const CHANNEL_WAIT_MS = 10_000;
const CHANNEL_POLL_MS = 50;

export type BridgeMessage =
  | { bridge: typeof BRIDGE_TAG; type: "ready" }
  | { bridge: typeof BRIDGE_TAG; type: "error"; reason: string }
  | { bridge: typeof BRIDGE_TAG; type: "height"; height: number };

const BRIDGE_SOURCE = `(function () {
  "use strict";
  var parents = __PARENTS__;
  var script = document.currentScript;
  var target = new URLSearchParams(location.search).get("parent");
  if (window.parent === window || target === null || parents.indexOf(target) === -1) return;
  function post(message) {
    message.bridge = ${JSON.stringify(BRIDGE_TAG)};
    window.parent.postMessage(message, target);
  }
  var failure = script ? script.getAttribute(${JSON.stringify(BRIDGE_ERROR_ATTRIBUTE)}) : null;
  if (failure) {
    post({ type: "error", reason: failure });
    return;
  }
  var settled = false;
  var heights = 0;
  function watchHeight() {
    var root = document.getElementById("storybook-root");
    if (!root || typeof ResizeObserver !== "function") return;
    var observer = new ResizeObserver(function () {
      heights += 1;
      post({ type: "height", height: Math.ceil(root.getBoundingClientRect().bottom + window.scrollY) });
      if (heights >= ${MAX_HEIGHTS}) observer.disconnect();
    });
    observer.observe(root);
  }
  function ready() {
    if (settled) return;
    settled = true;
    post({ type: "ready" });
    watchHeight();
  }
  function failed(reason) {
    if (settled) return;
    settled = true;
    post({ type: "error", reason: reason });
  }
  function attach(channel) {
    channel.on("storyRendered", ready);
    ["storyErrored", "storyMissing", "storyThrewException"].forEach(function (event) {
      channel.on(event, function () { failed(event); });
    });
  }
  var waited = 0;
  (function poll() {
    var channel = window.__STORYBOOK_ADDONS_CHANNEL__;
    if (channel && typeof channel.on === "function") return attach(channel);
    waited += ${CHANNEL_POLL_MS};
    if (waited < ${CHANNEL_WAIT_MS}) setTimeout(poll, ${CHANNEL_POLL_MS});
  })();
})();
`;

/** The bridge with the console's origins baked in: the only targets it will ever post to. */
export function bridgeScript(parents: readonly string[]): string {
  // `<` escaped so no origin string can close a script element, wherever the text ends up.
  return BRIDGE_SOURCE.replace("__PARENTS__", () => JSON.stringify(parents).replace(/</g, "\\u003c"));
}
