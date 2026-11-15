import type { ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";

type RecoverableErrorHandler = (error: unknown) => void;

/**
 * Adopts prerendered markup. react-native-web's AppRegistry hydrate takes no options and would route a mismatch to
 * window.onerror, so the client calls hydrateRoot itself and a mismatch reaches the handler.
 */
export function hydrate(container: Element, element: ReactNode, onRecoverableError: RecoverableErrorHandler): Root {
  return hydrateRoot(container, element, { onRecoverableError });
}
