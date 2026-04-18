import { useEffect, useState } from "react";
import { getDb } from "@/lib/local-db/idb";
import { logObservabilityEvent } from "@/lib/observability";

type HydrationState = {
  isHydrated: boolean;
  hydrationError: string | null;
  hydrationStage: "loading" | "ready" | "error";
  startedAtMs: number;
};

export function useLocalHydration(): HydrationState {
  const [state, setState] = useState<HydrationState>({
    isHydrated: false,
    hydrationError: null,
    hydrationStage: "loading",
    startedAtMs: 0,
  });

  useEffect(() => {
    let isMounted = true;
    const startedAtMs = Date.now();

    void (async () => {
      try {
        await getDb();
        if (!isMounted) return;
        logObservabilityEvent("hydration_ready", {
          elapsedMs: Date.now() - startedAtMs,
        });
        setState({
          isHydrated: true,
          hydrationError: null,
          hydrationStage: "ready",
          startedAtMs,
        });
      } catch (error: unknown) {
        if (!isMounted) return;
        const message = error instanceof Error ? error.message : "Failed to hydrate local data.";
        logObservabilityEvent("hydration_failed", {
          elapsedMs: Date.now() - startedAtMs,
          message,
        });
        setState({
          isHydrated: true,
          hydrationError: message,
          hydrationStage: "error",
          startedAtMs,
        });
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  return state;
}
