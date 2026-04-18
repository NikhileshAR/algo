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

    void (async () => {
      try {
        await getDb();
        if (!isMounted) return;
        setState({ isHydrated: true, hydrationError: null });
      } catch (error: unknown) {
        if (!isMounted) return;
        const message = error instanceof Error ? error.message : "Failed to hydrate local data.";
        setState({ isHydrated: true, hydrationError: message });
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  return state;
}
