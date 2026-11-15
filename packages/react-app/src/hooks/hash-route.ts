import { useSyncExternalStore } from "react";

/** A hand-typed hash can hold a lone `%`; keep the raw text rather than throw during render. */
export function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const readHash = (): string => window.location.hash;

/** Re-renders on every `hashchange` with the route `parse` reads from the current hash. */
export function useHashRoute<Route>(parse: (hash: string) => Route): Route {
  return parse(useSyncExternalStore(subscribe, readHash, readHash));
}
