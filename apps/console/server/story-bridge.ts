/**
 * The story bridge (TP-3793), served at `/__bridge.js` on the story origin and injected into each
 * stored build's `iframe.html`. It runs as the story, so it can read what the console page, on
 * another origin, cannot: whether Storybook rendered the story, how tall it is and where its
 * elements are. It posts `ready`, `error`, `height`, `boxes` and `key` to `window.parent`, only
 * ever to the page's own origin, and takes `args` from that origin's page alone.
 *
 * The page names its origin as `?parent=`, and the bridge posts nothing unless that origin is one
 * of the console's own. Story code shares this origin and can forge any of these messages, so
 * nothing the page does with one may change an answer: a forwarded key is only ever one of
 * FORWARDED_KEYS, which navigate and never pick or send (TP-3793 R3).
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
/** The page's navigation keys; never Enter, digits or letters, with which story code could pick or send an answer. */
export const FORWARDED_KEYS = ["[", "]", "Escape", "?"] as const;
/** What the bridge reports for pins: elements a test or a reader can name, as the harness's `closest('[data-testid]')`. */
const BOX_SELECTOR = "[data-testid], [role]";
export const MAX_BOXES = 2000;
export const MAX_BOX_TEXT = 120;
/** A scroll inside the story moves every box; one report per this many ms is enough to aim a pin. */
const SCROLL_BOXES_MS = 100;

interface BridgeBox {
  x: number;
  y: number;
  width: number;
  height: number;
  target: { testId?: string; role?: string; text?: string };
}

export type BridgeMessage =
  | { bridge: typeof BRIDGE_TAG; type: "ready" }
  | { bridge: typeof BRIDGE_TAG; type: "error"; reason: string }
  | { bridge: typeof BRIDGE_TAG; type: "height"; height: number }
  | { bridge: typeof BRIDGE_TAG; type: "boxes"; boxes: BridgeBox[] }
  | { bridge: typeof BRIDGE_TAG; type: "key"; key: (typeof FORWARDED_KEYS)[number] };

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
  var settled = null;
  var heights = 0;
  var storyId = new URLSearchParams(location.search).get("id");
  var channel = null;
  var args = null;
  var argsOwed = false;
  function targetOf(element) {
    var target = {};
    var testId = element.getAttribute("data-testid");
    var role = element.getAttribute("role");
    var text = (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, ${MAX_BOX_TEXT});
    if (testId) target.testId = testId;
    if (role) target.role = role;
    if (text) target.text = text;
    return target;
  }
  function postBoxes() {
    if (settled !== "ready") return;
    var found = document.querySelectorAll(${JSON.stringify(BOX_SELECTOR)});
    var boxes = [];
    for (var i = 0; i < found.length && boxes.length < ${MAX_BOXES}; i += 1) {
      var rect = found[i].getBoundingClientRect();
      boxes.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height, target: targetOf(found[i]) });
    }
    post({ type: "boxes", boxes: boxes });
  }
  var scrollQueued = false;
  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    setTimeout(function () { scrollQueued = false; postBoxes(); }, ${SCROLL_BOXES_MS});
  }
  function watchHeight() {
    var root = document.getElementById("storybook-root");
    if (!root || typeof ResizeObserver !== "function") return;
    var observer = new ResizeObserver(function () {
      heights += 1;
      post({ type: "height", height: Math.ceil(root.getBoundingClientRect().bottom + window.scrollY) });
      postBoxes();
      if (heights >= ${MAX_HEIGHTS}) observer.disconnect();
    });
    observer.observe(root);
  }
  function pushArgs() {
    if (channel && args && storyId) channel.emit("updateStoryArgs", { storyId: storyId, updatedArgs: args });
  }
  function rendered() {
    if (settled === null) {
      settled = "ready";
      post({ type: "ready" });
      watchHeight();
    }
    postBoxes();
    // Args sent before the story first rendered can be dropped by it, so they go once more, as the harness's storyArgs.
    if (argsOwed) {
      argsOwed = false;
      pushArgs();
    }
  }
  function failed(reason) {
    if (settled !== null) return;
    settled = "error";
    post({ type: "error", reason: reason });
  }
  function attach(found) {
    channel = found;
    channel.on("storyRendered", rendered);
    ["storyErrored", "storyMissing", "storyThrewException"].forEach(function (event) {
      channel.on(event, function () { failed(event); });
    });
    pushArgs();
  }
  var forwarded = ${JSON.stringify(FORWARDED_KEYS)};
  function typing(element) {
    return !!element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName || ""));
  }
  window.addEventListener("keydown", function (event) {
    if (forwarded.indexOf(event.key) === -1 || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
    post({ type: "key", key: event.key });
  }, true);
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== window.parent || event.origin !== target) return;
    if (!data || data.bridge !== ${JSON.stringify(BRIDGE_TAG)} || data.type !== "args" || !data.args || typeof data.args !== "object") return;
    args = data.args;
    argsOwed = true;
    pushArgs();
  });
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", postBoxes);
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
