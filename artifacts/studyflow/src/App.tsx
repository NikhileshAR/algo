import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Router as AppRouter } from "@/components/router";
import Intake from "@/pages/intake";
import { LocalDbProvider, useLocalDb } from "@/context/LocalDbContext";
import MigrationBanner from "@/components/MigrationBanner";
import { Loader2 } from "lucide-react";

const queryClient = new QueryClient();

/**
 * Guards the main app routes. If IndexedDB is ready but no profile exists,
 * redirects to /intake so the user completes setup before accessing the app.
 *
 * This is the LOCAL-FIRST onboarding gate — no server call is needed to
 * determine whether onboarding is required.
 */
function MainApp() {
  const { profile, ready } = useLocalDb();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (ready && !profile) {
      setLocation("/intake");
    }
  }, [ready, profile, setLocation]);

  if (!ready) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!profile) return null; // Redirect in-flight via effect above

  return <AppRouter />;
}

/** Redirects the legacy /onboarding path to /intake */
function LegacyOnboardingRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation("/intake");
  }, [setLocation]);
  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/*
         * LocalDbProvider initialises IndexedDB, runs the lazy schedule check,
         * and exposes all local data + mutation helpers to the component tree.
         * Server is never required — it is an optional sync relay only.
         */}
        <LocalDbProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Switch>
              {/* Primary onboarding route — chat-based intake engine */}
              <Route path="/intake" component={Intake} />
              {/* Legacy /onboarding path — redirect to /intake */}
              <Route path="/onboarding" component={LegacyOnboardingRedirect} />
              {/* All other routes — guarded by profile check */}
              <Route component={MainApp} />
            </Switch>
            <MigrationBanner />
          </WouterRouter>
        </LocalDbProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
