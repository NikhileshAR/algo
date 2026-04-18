import { useEffect, useRef, useState } from "react";
import { logObservabilityEvent } from "@/lib/observability";

const DEFAULT_LOADING_TIMEOUT_MS = 1800;

export function useBoundedLoading(
  key: string,
  isLoading: boolean,
  timeoutMs = DEFAULT_LOADING_TIMEOUT_MS,
): { timedOut: boolean; resetTimeout: () => void } {
  const [timedOut, setTimedOut] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoggedRef = useRef(false);

  useEffect(() => {
    if (!isLoading) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setTimedOut(false);
      hasLoggedRef.current = false;
      return;
    }

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      setTimedOut(true);
      if (!hasLoggedRef.current) {
        hasLoggedRef.current = true;
        logObservabilityEvent("loading_timeout", { key, timeoutMs });
      }
    }, timeoutMs);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [isLoading, key, timeoutMs]);

  return {
    timedOut,
    resetTimeout: () => {
      setTimedOut(false);
      hasLoggedRef.current = false;
    },
  };
}
