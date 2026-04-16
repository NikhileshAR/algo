import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Router as AppRouter } from "@/components/router";
import Onboarding from "@/pages/onboarding";
import { LocalDbProvider } from "@/context/LocalDbContext";
import MigrationBanner from "@/components/MigrationBanner";

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/*
         * LocalDbProvider initialises IndexedDB, boots the nightly scheduler,
         * and exposes all local data + mutation helpers to the component tree.
         * It sits inside QueryClientProvider so child components can still
         * use react-query for server calls during the transition period.
         */}
        <LocalDbProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Switch>
              <Route path="/onboarding" component={Onboarding} />
              <Route component={AppRouter} />
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
