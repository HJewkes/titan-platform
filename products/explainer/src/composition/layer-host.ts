/**
 * The global the page publishes its own React and motion modules under. A custom layer is bundled with each
 * allowlisted import read from it, so the layer shares the page's React and MotionProvider instead of shipping its own.
 */
export const LAYER_HOST_GLOBAL = "__explainerLayerHost";
