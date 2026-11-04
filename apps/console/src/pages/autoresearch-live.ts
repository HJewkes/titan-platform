import { useEffect, useState } from "react";

const TICK_MS = 1_000;

/** The clock running timers read; it ticks only while something is live, so a finished run renders once. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}
