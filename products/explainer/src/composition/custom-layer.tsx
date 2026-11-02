import * as motion from "@titan-design/react-ui/motion";
import { useBeatTime, useWaitUntil } from "@titan-design/react-ui/motion";
import * as React from "react";
import { useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { flushSync } from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import { LAYER_HOST_GLOBAL } from "./layer-host.js";
import { raiseTextToFloor } from "./text-floor.js";

type Layer = ComponentType;

const loading = new Map<string, Promise<Layer>>();
const loaded = new Map<string, Layer>();

function publishHost(): void {
  Object.assign(globalThis, { [LAYER_HOST_GLOBAL]: { react: React, "react/jsx-runtime": jsxRuntime, "@titan-design/react-ui/motion": motion } });
}

const isLayer = (value: unknown): value is Layer => typeof value === "function";

async function importLayer(url: string): Promise<Layer> {
  publishHost();
  const module: { default?: unknown } = await import(/* @vite-ignore */ new URL(url, location.href).href).catch((error: unknown) => {
    throw new Error(`custom layer ${url} failed to load: ${error instanceof Error ? error.message : String(error)}`);
  });
  const layer = module.default;
  if (!isLayer(layer)) throw new Error(`custom layer ${url} has no default export component`);
  loaded.set(url, layer);
  return layer;
}

/** One import per module URL, however often its beat mounts. */
function loadLayer(url: string): Promise<Layer> {
  const pending = loading.get(url) ?? importLayer(url);
  loading.set(url, pending);
  return pending;
}

type LayerState = { layer: Layer } | { error: unknown } | undefined;

const FILL = { position: "absolute", inset: 0 } as const;

/**
 * A custom layer's module, imported when its beat mounts and drawn once it loads. The import is a `useWaitUntil`
 * promise, so `__titanMotion.ready()` holds the frame until the layer has committed: no frame shows the beat blank.
 * A module that fails to load throws while rendering, which reaches the capture as a page error. The host reads the
 * beat clock itself, so it re-renders with the layer on every seek and raises the layer's text to the type floor after
 * each commit.
 */
export function CustomLayer({ url }: { url: string }) {
  useBeatTime();
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (box.current) raiseTextToFloor(box.current);
  });
  const [state, setState] = useState<LayerState>(() => (loaded.has(url) ? { layer: loaded.get(url)! } : undefined));
  const settled = useMemo(
    () => (state ? undefined : loadLayer(url).then((layer) => flushSync(() => setState({ layer })), (error: unknown) => flushSync(() => setState({ error })))),
    [url, state],
  );
  useWaitUntil(settled);
  if (state && "error" in state) throw state.error;
  const Drawn = state?.layer;
  return Drawn ? <div ref={box} style={FILL}><Drawn /></div> : null;
}
