import { useEffect, useRef, useState } from "react";
import { getDb } from "@/lib/local-db/idb";
import { logObservabilityEvent } from "@/lib/observability";

type HydrationState = {
  isHydrated: boolean;
  hydrationError: string | null;
  hydrationStage: "loading" | "ready" | "error";
  startedAtMs: number;
};

export function useLocalHydration(): HydrationState {
  const startedAtMsRef = useRef<number>(Date.now());
  const [state, setState] = useState<HydrationState>({
    isHydrated: false,
    hydrationError: null,
    hydrationStage: "loading",
    startedAtMs: startedAtMsRef.current,
  });

  useEffect(() => {
    let isMounted = true;

    void (async () => {
      try {
        await getDb();
        if (!isMounted) return;
        logObservabilityEvent("hydration_ready", {
          elapsedMs: Date.now() - startedAtMsRef.current,
        });
        setState({
          isHydrated: true,
          hydrationError: null,
          hydrationStage: "ready",
          startedAtMs: startedAtMsRef.current,
        });
      } catch (error: unknown) {
        if (!isMounted) return;
        const message = error instanceof Error ? error.message : "Failed to hydrate local data.";
        logObservabilityEvent("hydration_failed", {
          elapsedMs: Date.now() - startedAtMsRef.current,
          message,
        });
        setState({
          isHydrated: true,
          hydrationError: message,
          hydrationStage: "error",
          startedAtMs: startedAtMsRef.current,
        });
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  return state;
}
