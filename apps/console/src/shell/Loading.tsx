import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { Skeleton as DsSkeleton, Spinner as DsSpinner, type SkeletonProps, type SpinnerProps } from "@titan-design/react-ui";
import type { ViewKey } from "../view-keys.js";
import type { WaitTracker } from "../data/waits.js";

const WaitTrackerContext = createContext<WaitTracker | null>(null);
export const WaitTrackerProvider = WaitTrackerContext.Provider;

/** Charges later waits to the route's view; set during render so a page's first loader already sees it. */
export function useWaitView(view: ViewKey): void {
  const tracker = useContext(WaitTrackerContext);
  const last = useRef<ViewKey | null>(null);
  if (!tracker || last.current === view) return;
  last.current = view;
  tracker.setView(view);
}

/** Times a loading state the owner sees: from `visible` turning true until it turns false or the caller unmounts. */
export function useWait(visible: boolean, mutation = false): void {
  const tracker = useContext(WaitTrackerContext);
  useEffect(() => (tracker && visible ? tracker.show(mutation) : undefined), [tracker, visible, mutation]);
}

interface WaitProps {
  /** The spinner stands for a button's write rather than a page's read. */
  mutation?: boolean;
}

/** react-ui's spinner, timed as a wait while it is mounted. */
export function Spinner({ mutation = false, ...props }: SpinnerProps & WaitProps): ReactNode {
  useWait(true, mutation);
  return <DsSpinner {...props} />;
}

/** react-ui's skeleton, timed as a wait while it is mounted; a page's several skeletons are one wait. */
export function Skeleton(props: SkeletonProps): ReactNode {
  useWait(true);
  return <DsSkeleton {...props} />;
}
