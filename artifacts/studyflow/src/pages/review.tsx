import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import {
  AlertTriangle,
  CalendarDays,
  Clock,
  TrendingUp,
  ShieldCheck,
  RotateCcw,
} from "lucide-react";
import { useLocalHydration } from "@/hooks/use-local-hydration";
import { useBoundedLoading } from "@/hooks/use-bounded-loading";
import { logObservabilityEvent } from "@/lib/observability";
import { studyflowQueryKeys } from "@/lib/query-keys";

interface WeeklyReview {
  weeklySessions: Array<{
    id: number;
    topicId: number;
    topicName: string;
    sessionType: string;
    durationMinutes: number;
    testScore: number | null;
    testScoreMax: number | null;
    studiedAt: string;
  }>;
  totalMinutes: number;
  totalHours: number;
  previousWeekMinutes: number;
  previousWeekHours: number;
  practiceCount: number;
  lectureCount: number;
  previousWeekPracticeCount: number;
  previousWeekLectureCount: number;
  daysWithStudy: number;
  previousWeekDaysWithStudy: number;
  dailyHours: Array<{ date: string; label: string; minutes: number; hours: number }>;
  consistencyDroppedMidWeek: boolean;
  skippedPracticeSessions: boolean;
  recoveryDays: number;
}

const DAYS_IN_WEEK = 7;

const EMPTY_WEEKLY_REVIEW: WeeklyReview = {
  weeklySessions: [],
  totalMinutes: 0,
  totalHours: 0,
  previousWeekMinutes: 0,
  previousWeekHours: 0,
  practiceCount: 0,
  lectureCount: 0,
  previousWeekPracticeCount: 0,
  previousWeekLectureCount: 0,
  daysWithStudy: 0,
  previousWeekDaysWithStudy: 0,
  dailyHours: Array.from({ length: 7 }).map((_, index) => ({
    date: new Date(Date.now() - (6 - index) * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    label: new Date(Date.now() - (6 - index) * 24 * 60 * 60 * 1000).toLocaleDateString("en-US", { weekday: "short" }),
    minutes: 0,
    hours: 0,
  })),
  consistencyDroppedMidWeek: false,
  skippedPracticeSessions: false,
  recoveryDays: 0,
};

function normalizeWeeklyReview(raw: unknown): WeeklyReview {
  if (!raw || typeof raw !== "object") {
    return EMPTY_WEEKLY_REVIEW;
  }

  const input = raw as Partial<WeeklyReview>;
  const dailyHours = Array.isArray(input.dailyHours)
    ? input.dailyHours.map((entry) => ({
      date: typeof entry?.date === "string" ? entry.date : "",
      label: typeof entry?.label === "string" ? entry.label : "",
      minutes: typeof entry?.minutes === "number" && Number.isFinite(entry.minutes) ? Math.max(0, entry.minutes) : 0,
      hours: typeof entry?.hours === "number" && Number.isFinite(entry.hours) ? Math.max(0, entry.hours) : 0,
    }))
    : EMPTY_WEEKLY_REVIEW.dailyHours;

  return {
    weeklySessions: Array.isArray(input.weeklySessions) ? input.weeklySessions : [],
    totalMinutes: typeof input.totalMinutes === "number" && Number.isFinite(input.totalMinutes) ? Math.max(0, input.totalMinutes) : 0,
    totalHours: typeof input.totalHours === "number" && Number.isFinite(input.totalHours) ? Math.max(0, input.totalHours) : 0,
    previousWeekMinutes: typeof input.previousWeekMinutes === "number" && Number.isFinite(input.previousWeekMinutes) ? Math.max(0, input.previousWeekMinutes) : 0,
    previousWeekHours: typeof input.previousWeekHours === "number" && Number.isFinite(input.previousWeekHours) ? Math.max(0, input.previousWeekHours) : 0,
    practiceCount: typeof input.practiceCount === "number" && Number.isFinite(input.practiceCount) ? Math.max(0, input.practiceCount) : 0,
    lectureCount: typeof input.lectureCount === "number" && Number.isFinite(input.lectureCount) ? Math.max(0, input.lectureCount) : 0,
    previousWeekPracticeCount: typeof input.previousWeekPracticeCount === "number" && Number.isFinite(input.previousWeekPracticeCount) ? Math.max(0, input.previousWeekPracticeCount) : 0,
    previousWeekLectureCount: typeof input.previousWeekLectureCount === "number" && Number.isFinite(input.previousWeekLectureCount) ? Math.max(0, input.previousWeekLectureCount) : 0,
    daysWithStudy: typeof input.daysWithStudy === "number" && Number.isFinite(input.daysWithStudy) ? Math.max(0, Math.min(7, input.daysWithStudy)) : 0,
    previousWeekDaysWithStudy:
      typeof input.previousWeekDaysWithStudy === "number" && Number.isFinite(input.previousWeekDaysWithStudy)
        ? Math.max(0, Math.min(7, input.previousWeekDaysWithStudy))
        : 0,
    dailyHours: dailyHours.length > 0 ? dailyHours : EMPTY_WEEKLY_REVIEW.dailyHours,
    consistencyDroppedMidWeek: Boolean(input.consistencyDroppedMidWeek),
    skippedPracticeSessions: Boolean(input.skippedPracticeSessions),
    recoveryDays: typeof input.recoveryDays === "number" && Number.isFinite(input.recoveryDays) ? Math.max(0, input.recoveryDays) : 0,
  };
}

function formatHours(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export default function Review() {
  const queryClient = useQueryClient();
  const { isHydrated } = useLocalHydration();
  const { data, isLoading, isError } = useQuery<WeeklyReview>({
    queryKey: studyflowQueryKeys.analyticsWeeklyReview(),
    queryFn: async () => {
      const response = await fetch("/api/analytics/weekly-review");
      if (!response.ok) {
        throw new Error("Failed to load weekly review.");
      }
      const raw = await response.json();
      return normalizeWeeklyReview(raw);
    },
    retry: false,
  });
  const isLoadingReview = !isHydrated || isLoading;
  const { timedOut: reviewTimedOut, resetTimeout: resetReviewTimeout } = useBoundedLoading(
    "review-weekly",
    isLoadingReview,
  );

  useEffect(() => {
    if (reviewTimedOut) {
      logObservabilityEvent("fallback_triggered", { scope: "weekly-review", reason: "timeout" });
    }
  }, [reviewTimedOut]);

  const weekStr = (() => {
    const today = new Date();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return `${weekAgo.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${today.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  })();

  const hasDailySeries = Boolean(data?.dailyHours?.length === DAYS_IN_WEEK);
  const hasCoreMetrics = typeof data?.totalMinutes === "number" && typeof data?.daysWithStudy === "number";
  const hasWeeklySessions = (data?.weeklySessions.length ?? 0) > 0;

  const viewState: "loading" | "error" | "empty" | "partial" | "ready" | "fallback" =
    isLoadingReview
      ? reviewTimedOut
        ? "fallback"
        : "loading"
      : isError
        ? "error"
        : !data || !hasWeeklySessions
          ? "empty"
          : !hasDailySeries || !hasCoreMetrics
            ? "partial"
            : "ready";

  if (viewState === "loading") {
    return (
      <div className="space-y-6">
        <div><Skeleton className="h-8 w-48 mb-2" /><Skeleton className="h-4 w-32" /></div>
        <div className="grid gap-4 md:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const reviewData: WeeklyReview = (viewState === "ready" || viewState === "partial") && data ? data : EMPTY_WEEKLY_REVIEW;
  const hoursDelta = reviewData.totalHours - reviewData.previousWeekHours;
  const consistencyDelta = reviewData.daysWithStudy - reviewData.previousWeekDaysWithStudy;
  const hasAnyStudy = reviewData.totalMinutes > 0;

  return (
    <div className="space-y-6" data-testid="review-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Weekly Review</h1>
        <p className="text-muted-foreground">{weekStr}</p>
      </div>

      {viewState === "error" && (
        <Card>
          <CardContent className="py-3 text-sm text-muted-foreground">
            We couldn’t load this week’s data. Retry to restore the real weekly report.
          </CardContent>
        </Card>
      )}
      {viewState === "fallback" && (
        <Card>
          <CardContent className="py-3 text-sm text-muted-foreground space-y-3">
            <p>Weekly review is taking longer than expected, so fallback mode is active.</p>
            <Button
              variant="outline"
              onClick={() => {
                logObservabilityEvent("retry_requested", { scope: "weekly-review" });
                resetReviewTimeout();
                queryClient.invalidateQueries({ queryKey: studyflowQueryKeys.analyticsWeeklyReview() });
              }}
            >
              Retry weekly review
            </Button>
          </CardContent>
        </Card>
      )}
      {viewState === "empty" && (
        <Card>
          <CardContent className="py-3 text-sm text-muted-foreground">
            No data yet. Complete your first session to start weekly insights.
          </CardContent>
        </Card>
      )}
      {viewState === "partial" && (
        <Card>
          <CardContent className="py-3 text-sm text-muted-foreground">
            Partial data available. Some weekly signals are still being reconstructed.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Clock className="h-4 w-4" />Weekly Progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold">{formatHours(reviewData.totalMinutes)}</p>
            <p className="text-xs text-muted-foreground">
              {`${hoursDelta > 0 ? "+" : ""}${hoursDelta.toFixed(1)}h vs last week`}
            </p>
            <p className="text-xs text-muted-foreground">{reviewData.weeklySessions.length} sessions across {reviewData.daysWithStudy}/7 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><TrendingUp className="h-4 w-4" />Behavioral Insight</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {reviewData.skippedPracticeSessions ? (
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600" />
                <span>You are skipping practice sessions and leaning on lectures.</span>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-sm">
                <ShieldCheck className="h-4 w-4 mt-0.5 text-emerald-600" />
                <span>You kept practice in your routine this week.</span>
              </div>
            )}

            {reviewData.consistencyDroppedMidWeek ? (
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600" />
                <span>Your consistency dropped mid-week.</span>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-sm">
                <CalendarDays className="h-4 w-4 mt-0.5 text-emerald-600" />
                <span>Your consistency held steady through the week.</span>
              </div>
            )}

            <p className="text-xs text-muted-foreground">{consistencyDelta >= 0 ? `+${consistencyDelta}` : `${consistencyDelta}`} study days vs last week.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><RotateCcw className="h-4 w-4" />Recovery Insight</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {hasAnyStudy ? (
              <>
                <p className="text-sm font-medium">
                  {reviewData.recoveryDays > 0
                    ? `You recovered in ${reviewData.recoveryDays} day${reviewData.recoveryDays === 1 ? "" : "s"} after a break.`
                    : "No break recovery event this week — you stayed in rhythm."}
                </p>
                <p className="text-xs text-muted-foreground">Use short restart sessions after breaks to recover faster.</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No sessions yet this week. Start with one focused block today.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily Study Hours</CardTitle>
          <CardDescription>See where your week accelerated or slipped.</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={reviewData.dailyHours}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                formatter={(v: number) => [`${v.toFixed(1)}h`, "Study"]}
              />
              <Bar dataKey="hours" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-3 flex items-center justify-between gap-3">
          <span className="text-sm">Next move: start today’s first high-priority session now.</span>
          <Badge>Execution first</Badge>
        </CardContent>
      </Card>
    </div>
  );
}
