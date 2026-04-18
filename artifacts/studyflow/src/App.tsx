import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Router as AppRouter } from "@/components/router";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocalHydration } from "@/hooks/use-local-hydration";
import { useBoundedLoading } from "@/hooks/use-bounded-loading";
import { logObservabilityEvent } from "@/lib/observability";
import Onboarding from "@/pages/onboarding";

const queryClient = new QueryClient();

function App() {
  const { isHydrated, hydrationError } = useLocalHydration();
  const loadingHydration = !isHydrated;
  const { timedOut } = useBoundedLoading("app-hydration", loadingHydration);

  useEffect(() => {
    if (loadingHydration && timedOut) {
      logObservabilityEvent("hydration_slow", { timeoutMs: 1800 });
    }
  }, [loadingHydration, timedOut]);

  if (loadingHydration && !timedOut) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (loadingHydration && timedOut) {
    return (
      <div className="p-4">
        <Card>
          <CardContent className="py-6 space-y-3">
            <p className="text-sm text-muted-foreground">
              Local data is taking longer than expected to initialize.
            </p>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (hydrationError) {
    return (
      <div className="p-4">
        <Card>
          <CardContent className="py-6 space-y-3">
            <p className="text-sm text-muted-foreground">
              Local data could not be initialized. Retry to recover.
            </p>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Switch>
            <Route path="/onboarding" component={Onboarding} />
            <Route component={AppRouter} />
          </Switch>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
