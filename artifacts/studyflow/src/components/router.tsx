import { Layout } from "@/components/layout";
import { Switch, Route } from "wouter";
import Dashboard from "@/pages/dashboard";
import Schedule from "@/pages/schedule";
import Execute from "@/pages/execute";
import Topics from "@/pages/topics";
import Sessions from "@/pages/sessions";
import Settings from "@/pages/settings";
import Review from "@/pages/review";
import NotFound from "@/pages/not-found";

export function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/schedule" component={Schedule} />
        {/* Execute route renders fullscreen — Layout suppresses sidebar for this path */}
        <Route path="/execute/:blockIndex" component={Execute} />
        <Route path="/topics" component={Topics} />
        <Route path="/sessions" component={Sessions} />
        <Route path="/review" component={Review} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}
