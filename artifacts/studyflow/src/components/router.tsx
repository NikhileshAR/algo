import { Layout } from "@/components/layout";
import { Switch, Route } from "wouter";
import Dashboard from "@/pages/dashboard";
import Onboarding from "@/pages/onboarding";
import Schedule from "@/pages/schedule";
import Topics from "@/pages/topics";
import Sessions from "@/pages/sessions";
import Settings from "@/pages/settings";
import NotFound from "@/pages/not-found";

export function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/schedule" component={Schedule} />
        <Route path="/topics" component={Topics} />
        <Route path="/sessions" component={Sessions} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}
