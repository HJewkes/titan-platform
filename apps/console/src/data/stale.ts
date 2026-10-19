import { useEffect, useRef, useState } from "react";
import { useEvents } from "./rpc.js";

/**
 * When the event stream last dropped, or null while it is open. Reads stay current up to the
 * drop, so its time bounds how old they may be. A stream that never opened (a page still
 * dialling on load) reports null, since its reads were just fetched.
 */
export function useStaleSince(): Date | null {
  const status = useEvents();
  const [since, setSince] = useState<Date | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (status === "open") {
      wasOpen.current = true;
      setSince(null);
    } else if (wasOpen.current) {
      setSince((current) => current ?? new Date());
    }
  }, [status]);
  return since;
}
