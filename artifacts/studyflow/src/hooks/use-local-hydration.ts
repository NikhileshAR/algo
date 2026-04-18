import { useEffect, useState } from "react";
import { getDb } from "@/lib/local-db/idb";

type HydrationState = {
  isHydrated: boolean;
  hydrationError: string | null;
};

export function useLocalHydration(): HydrationState {
  const [state, setState] = useState<HydrationState>({
    isHydrated: false,
    hydrationError: null,
  });

  useEffect(() => {
    let isMounted = true;

    void getDb()
      .catch((error: unknown) => {
        if (!isMounted) return;
        const message = error instanceof Error ? error.message : "Failed to hydrate local data.";
        setState({ isHydrated: true, hydrationError: message });
      })
      .then(() => {
        if (!isMounted) return;
        setState((prev) => ({ isHydrated: true, hydrationError: prev.hydrationError }));
      });

    return () => {
      isMounted = false;
    };
  }, []);

  return state;
}
