import { Brain, TrendingUp, TrendingDown, Minus, AlertTriangle, Target, Zap, CalendarDays, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { SmartRecommendations } from "@/lib/recommendations";
import type { StudyPlanItem } from "@/lib/adaptive-scheduler";

// ---------------------------------------------------------------------------
// Session type helpers
// ---------------------------------------------------------------------------

const SESSION_TYPE_LABELS: Record<StudyPlanItem["sessionType"], string> = {
  revision: "Revision",
  active_recall: "Active Recall",
  weak_repair: "Weak Repair",
  new_learning: "New Learning",
};

const DIFFICULTY_BADGE: Record<StudyPlanItem["difficultyAdjustment"], { label: string; variant: "default" | "secondary" | "outline" }> = {
  up: { label: "Difficulty ↑", variant: "default" },
  stable: { label: "Stable", variant: "secondary" },
  down: { label: "Difficulty ↓", variant: "outline" },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FocusTrendIndicator({ trend, summary }: { trend: SmartRecommendations["focusTrend"]; summary: string }) {
  const Icon = trend === "improving" ? TrendingUp : trend === "declining" ? TrendingDown : Minus;
  const colorClass = trend === "improving" ? "text-emerald-600" : trend === "declining" ? "text-rose-600" : "text-amber-600";

  return (
    <div className="flex items-start gap-2.5 text-sm rounded-lg border px-3 py-2.5">
      <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${colorClass}`} />
      <span className="text-muted-foreground">{summary}</span>
    </div>
  );
}

function PlanCard({ item }: { item: StudyPlanItem }) {
  const diff = DIFFICULTY_BADGE[item.difficultyAdjustment];
  return (
    <div className="flex items-start gap-3 rounded-lg border px-3 py-2.5 bg-muted/30">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <span className="text-sm font-medium">{item.topicName}</span>
          <Badge variant={diff.variant} className="text-xs py-0">{diff.label}</Badge>
          <Badge variant="outline" className="text-xs py-0">{SESSION_TYPE_LABELS[item.sessionType]}</Badge>
        </div>
        {item.reasonTags.length > 0 && (
          <p className="text-xs text-muted-foreground truncate">{item.reasonTags[0]}</p>
        )}
      </div>
      <div className="text-xs text-muted-foreground shrink-0 pt-0.5">{item.recommendedMinutes}m</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface AdaptiveInsightsPanelProps {
  recommendations: SmartRecommendations | null;
  isLoading: boolean;
}

export function AdaptiveInsightsPanel({ recommendations: recs, isLoading }: AdaptiveInsightsPanelProps) {
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (!recs) {
    return null;
  }

  const hasContent =
    recs.nextBestTopic ||
    recs.weakestSkill ||
    recs.atRiskOfForgetting.length > 0 ||
    recs.tomorrowPlan.length > 0;

  if (!hasContent) {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Brain className="h-5 w-5 text-primary" />
        <h2 className="text-base font-semibold tracking-tight">Adaptive Intelligence</h2>
      </div>

      {/* Focus trend */}
      <FocusTrendIndicator trend={recs.focusTrend} summary={recs.focusTrendSummary} />

      <div className="grid gap-4 md:grid-cols-2">
        {/* Next best topic */}
        {recs.nextBestTopic && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <Zap className="h-4 w-4" />
                Why this topic today
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-semibold text-base">{recs.nextBestTopic.topicName}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{recs.nextBestTopic.reason}</p>
            </CardContent>
          </Card>
        )}

        {/* Weakest skill */}
        {recs.weakestSkill && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <Target className="h-4 w-4" />
                Your weakest area
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-semibold text-base">{recs.weakestSkill.topicName}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{recs.weakestSkill.masteryPct}% mastery — needs dedicated practice</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* At risk of forgetting */}
      {recs.atRiskOfForgetting.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              At risk of forgetting
            </CardTitle>
            <CardDescription>These topics are decaying — schedule a review soon</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {recs.atRiskOfForgetting.slice(0, 3).map((t) => (
              <div key={t.topicId} className="flex items-center justify-between text-sm">
                <span className="font-medium">{t.topicName}</span>
                <span className="text-xs text-rose-600">{t.retentionPct}% retained</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Tomorrow's plan */}
      {recs.tomorrowPlan.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <CalendarDays className="h-4 w-4" />
              Prediction: tomorrow's plan
            </CardTitle>
            <CardDescription>Projected priorities if today's sessions follow through</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {recs.tomorrowPlan.slice(0, 4).map((item) => (
              <PlanCard key={item.topicId} item={item} />
            ))}
            {recs.tomorrowPlan.length > 4 && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground pt-1">
                <ChevronRight className="h-3 w-3" />
                {recs.tomorrowPlan.length - 4} more topics in tomorrow's plan
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
