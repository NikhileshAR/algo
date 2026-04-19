import { useEffect, useMemo, useRef } from "react";
import { useLocation, Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetStudentProfile,
  getGetStudentProfileQueryKey,
  useListSessions,
  useListTopics,
  type DailySchedule,
  getGetTodayScheduleQueryKey,
  useRecalculateSchedule,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, Clock3, CircleCheck, PlayCircle, AlertTriangle, RefreshCw, Sparkles, Flame, TrendingUp } from "lucide-react";
import { useLocalHydration } from "@/hooks/use-local-hydration";
import { useBoundedLoading } from "@/hooks/use-bounded-loading";
import { logObservabilityEvent } from "@/lib/observability";

type RiskSignal = {
  backlogRisk: number;
  fallingBehind: boolean;
  intervention: "none" | "reduced_targets" | "priority_concentration" | "early_reset";
};

type ControlSnapshot = {
  forecast?: {
    expectedCoverageByExamDate?: number;
    riskSignal?: RiskSignal;
    overrideAdjustedProjection?: {
      completionProbability: number;
      requiredHoursPerDay: number;
      coachingMessage: string;
    };
  };
  performanceGap?: {
    studyHoursDeviation?: number;
  };
};

type EngagementState = {
  mode: "normal" | "low_capacity" | "reentry";
  inactiveDays: number;
  identity: {
    streakDays: number;
    daysStudiedThisWeek: number;
    label: string;
    showUpMessage: string;
  };
  autonomyGuard: {
    isEarned: boolean;
    consistencyScore: number;
    frictionMultiplier: number;
  };
  confidenceCalibration: {
    overconfidenceRatio: number;
    underconfidenceRatio: number;
    sessionTypeRecommendation: "more_practice" | "more_lecture" | "balanced";
  };
  emotionalFeedback: string;
  forecastActionMessage: string;
};

type ExtendedSchedule = DailySchedule & {
  riskSignal?: RiskSignal;
  control?: ControlSnapshot;
  engagement?: EngagementState;
};

type MissionFallbackBlock = {
  isFallback: true;
  topicId: number;
  topicName: string;
  durationMinutes: number;
  sessionType: "lecture" | "practice";
};

type RenderMissionBlock =
  | { block: BlockWithExplanation; index: number; status: "done" | "continue" | "now" | "next"; isFallback: false }
  | { block: MissionFallbackBlock; index: number; status: "next"; isFallback: true };

const EXPLANATION_DISPLAY_THRESHOLD = 0.5;
const STRONG_MOMENTUM_MINUTES = 90;
const ALMOST_THERE_MINUTES = 60;
const MIN_CATCHUP_HOURS = 0.5;
const MISSION_RETRY_LIMIT = 1;
const COLD_START_SESSION_THRESHOLD = 5;
const COLD_START_MASTERY_THRESHOLD = 0.1;
const FALLBACK_LECTURE_MASTERY_THRESHOLD = 0.2;
const FALLBACK_PRIMARY_DURATION_MINUTES = 30;
const FALLBACK_SECONDARY_DURATION_MINUTES = 20;
const MEDIUM_CONFIDENCE_SESSION_THRESHOLD = 14;

type BlockWithExplanation = DailySchedule["blocks"][number] & {
  explanation?: {
    priorityContribution?: { lowMastery?: number; weightage?: number };
    decayPressure?: { pressure?: number };
    dependencyTriggers?: { pressure?: number };
    recentPerformanceSignal?: { pressure?: number };
  };
};

function toIsoDay(): string {
  return new Date().toISOString().split("T")[0];
}

function isIsoDayMatch(studiedAt: unknown, day: string): boolean {
  return typeof studiedAt === "string" && studiedAt.startsWith(day);
}

function formatHoursFromMinutes(totalMinutes: number): string {
  return (Math.round((totalMinutes / 60) * 10) / 10).toFixed(1);
}

function missionMomentumLabel(completion: number, completedMinutes: number, remainingMinutes: number): string {
  if (completion >= 100) return "Mission complete";
  if (completedMinutes >= STRONG_MOMENTUM_MINUTES) return "Strong momentum";
  if (completedMinutes > 0 && remainingMinutes <= ALMOST_THERE_MINUTES) return "Almost there";
  if (completedMinutes > 0) return "In motion";
  return "Ready to begin";
}

function missionStatusBadge(status: "done" | "continue" | "now" | "next"): {
  variant: "default" | "secondary" | "outline";
  label: string;
} {
  if (status === "done") return { variant: "secondary", label: "Done" };
  if (status === "continue") return { variant: "default", label: "Continue now" };
  if (status === "now") return { variant: "default", label: "Do now" };
  return { variant: "outline", label: "Up next" };
}

function interventionMessage(intervention: RiskSignal["intervention"] | undefined): string {
  if (intervention === "early_reset") return "Tomorrow auto-adjusts with a lighter recovery load.";
  if (intervention === "priority_concentration") return "Tomorrow auto-focuses on fewer high-impact topics.";
  if (intervention === "reduced_targets") return "Tomorrow auto-trims targets to restore consistency.";
  return "Tomorrow will adapt automatically based on today’s completion.";
}

function identityStreakIcon(streakDays: number): string {
  return streakDays >= 3 ? "🔥" : streakDays >= 1 ? "⚡" : "✨";
}

function blockReason(block: BlockWithExplanation): string {
  const ex = block.explanation;
  if (!ex) return `Selected by scheduler priority (${Math.round(block.priorityScore * 100)} score).`;

  const lowMasteryContribution = ex.priorityContribution?.lowMastery ?? 0;
  const decay = ex.decayPressure?.pressure ?? 0;
  const dependency = ex.dependencyTriggers?.pressure ?? 0;
  const performance = ex.recentPerformanceSignal?.pressure ?? 0;

  if (lowMasteryContribution >= EXPLANATION_DISPLAY_THRESHOLD) return "Your mastery signal is still developing here, so this block has high learning upside.";
  if (decay >= EXPLANATION_DISPLAY_THRESHOLD) return "Retention is decaying, so this was pulled forward to prevent forgetting.";
  if (dependency >= EXPLANATION_DISPLAY_THRESHOLD) return "It unlocks downstream topics and improves overall coverage.";
  if (performance >= EXPLANATION_DISPLAY_THRESHOLD) return "Recent performance confidence is lower, so the system is reinforcing it now.";

  return "It is currently one of the highest-priority blocks based on mastery, urgency, and readiness.";
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const recalculate = useRecalculateSchedule();
  const attemptedAutoRecalcRef = useRef(false);
  // Track whether a fallback mission was shown so we can log reconciliation.
  const fallbackWasShownRef = useRef(false);
  const { isHydrated, hydrationError } = useLocalHydration();

  const { data: profile, isError: profileError, isLoading: profileLoading } = useGetStudentProfile({
    query: { queryKey: getGetStudentProfileQueryKey(), retry: false },
  });
  const { data: topics } = useListTopics();
  const { data: sessions } = useListSessions({ limit: 200 });

  const {
    data: scheduleWithControl,
    isLoading: scheduleLoading,
    isError: scheduleError,
    error: scheduleFetchError,
  } = useQuery<ExtendedSchedule>({
    queryKey: getGetTodayScheduleQueryKey(),
    queryFn: async () => {
      const response = await fetch("/api/schedule/today");
      if (!response.ok) {
        throw new Error("Failed to load today's schedule.");
      }
      return response.json() as Promise<ExtendedSchedule>;
    },
    refetchInterval: 10000,
    // One bounded retry so mission fetch retry window stays within loading timeout budget.
    retry: MISSION_RETRY_LIMIT,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2000),
  });

  const isLoadingMission = !isHydrated || profileLoading || scheduleLoading;
  const { timedOut: missionLoadTimedOut, resetTimeout: resetMissionTimeout } = useBoundedLoading(
    "dashboard-mission",
    isLoadingMission,
  );

  useEffect(() => {
    if (!profileLoading && profileError) {
      setLocation("/onboarding");
    }
  }, [profileLoading, profileError, setLocation]);

  const hasTopics = (topics?.length ?? 0) > 0;
  const historicalSessionCount = sessions?.length ?? 0;
  const avgMastery = hasTopics
    ? (topics ?? []).reduce((sum, topic) => sum + topic.masteryScore, 0) / (topics ?? []).length
    : 0;
  const isColdStart =
    historicalSessionCount < COLD_START_SESSION_THRESHOLD &&
    avgMastery <= COLD_START_MASTERY_THRESHOLD;

  useEffect(() => {
    if (scheduleError) {
      logObservabilityEvent("mission_fetch_failed", {
        message: scheduleFetchError instanceof Error ? scheduleFetchError.message : "Unknown schedule fetch failure",
      });
    }
  }, [scheduleError, scheduleFetchError]);

  useEffect(() => {
    if (missionLoadTimedOut) {
      logObservabilityEvent("fallback_triggered", { scope: "dashboard", reason: "timeout" });
    }
  }, [missionLoadTimedOut]);

  useEffect(() => {
    const shouldSkipAutoRecalc =
      !isHydrated ||
      scheduleLoading ||
      Boolean(scheduleWithControl) ||
      !hasTopics ||
      recalculate.isPending ||
      attemptedAutoRecalcRef.current;

    if (shouldSkipAutoRecalc) {
      return;
    }
    attemptedAutoRecalcRef.current = true;
    recalculate.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
      },
    });
  }, [
    isHydrated,
    scheduleLoading,
    scheduleWithControl,
    hasTopics,
    recalculate,
    queryClient,
  ]);

  const today = toIsoDay();
  const schedule = scheduleWithControl;
  const scheduleBlocks = (Array.isArray(schedule?.blocks) ? schedule.blocks : []) as BlockWithExplanation[];
  const totalMinutes = typeof schedule?.scheduledHours === "number"
    ? Math.max(0, Math.round(schedule.scheduledHours * 60))
    : scheduleBlocks.reduce((sum, b) => sum + b.durationMinutes, 0);

  const completedMinutes = useMemo(() => {
    if (!sessions) return 0;
    return sessions
      .filter((s) => isIsoDayMatch(s.studiedAt, today))
      .reduce((sum, s) => sum + s.durationMinutes, 0);
  }, [sessions, today]);

  const completion = totalMinutes > 0 ? Math.min(100, Math.round((completedMinutes / totalMinutes) * 100)) : 0;
  const remainingMinutes = Math.max(totalMinutes - completedMinutes, 0);
  const momentumLabel = missionMomentumLabel(completion, completedMinutes, remainingMinutes);

  const paceBehind =
    Boolean(scheduleWithControl?.control?.forecast?.riskSignal?.fallingBehind) ||
    Boolean(scheduleWithControl?.riskSignal?.fallingBehind);

  const gapHours = scheduleWithControl?.control?.performanceGap?.studyHoursDeviation ?? 0;
  const fellShortHours = gapHours < 0 ? Math.abs(gapHours) : 0;
  const suggestedCatchupHours = Math.max(MIN_CATCHUP_HOURS, Math.round(fellShortHours * 10) / 10);
  const intervention = scheduleWithControl?.riskSignal?.intervention ?? scheduleWithControl?.control?.forecast?.riskSignal?.intervention;

  // Engagement state from schedule response (server-computed)
  const engagement = scheduleWithControl?.engagement;
  const engagementMode = engagement?.mode ?? "normal";
  const isReentryMode = engagementMode === "reentry";
  const isLowCapacityMode = engagementMode === "low_capacity";
  const identity = engagement?.identity;
  const autonomyEarned = engagement?.autonomyGuard?.isEarned ?? false;
  const confidenceCalibration = engagement?.confidenceCalibration;

  // Forecast action message — always risk + action (from server, with server-level context)
  const forecastActionMsg = engagement?.forecastActionMessage
    ?? (paceBehind
      ? `You're slightly behind pace — adding ~${suggestedCatchupHours.toFixed(1)}h/day this week will bring you back on track.`
      : "You're on track. Keep following today's sequence.");

  // Emotional feedback from server, fallback to generic
  const emotionalFeedbackMsg = engagement?.emotionalFeedback ?? "";

  const numberedBlocks = useMemo(() => {
    let spent = completedMinutes;
    let assignedCurrent = false;

    return scheduleBlocks.map((block, index) => {
      if (spent >= block.durationMinutes) {
        spent -= block.durationMinutes;
        return { block, index, status: "done" as const };
      }

      if (!assignedCurrent) {
        const hasStartedCurrent = spent > 0;
        assignedCurrent = true;
        return { block, index, status: hasStartedCurrent ? "continue" as const : "now" as const };
      }

      return { block, index, status: "next" as const };
    });
  }, [scheduleBlocks, completedMinutes]);

  const firstPendingIndex = numberedBlocks.find((nb) => nb.status !== "done")?.index ?? 0;

  const fallbackMissionBlocks = useMemo<MissionFallbackBlock[]>(() => {
    return (topics ?? [])
      .slice()
      .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
      .slice(0, 2)
      .map((topic, index) => ({
        isFallback: true,
        topicId: topic.id,
        topicName: topic.name,
        durationMinutes: index === 0 ? FALLBACK_PRIMARY_DURATION_MINUTES : FALLBACK_SECONDARY_DURATION_MINUTES,
        sessionType: topic.masteryScore < FALLBACK_LECTURE_MASTERY_THRESHOLD ? "lecture" : "practice",
      }));
  }, [topics]);

  const hasFallbackMission = fallbackMissionBlocks.length > 0;

  const dashboardState: "loading" | "ready" | "empty" | "error" | "fallback" =
    isLoadingMission
      ? missionLoadTimedOut
        ? "fallback"
        : "loading"
      : hydrationError || profileError
        ? "error"
        : scheduleError && hasFallbackMission
          ? "fallback"
          : scheduleError
            ? "error"
            : "ready";

  const showFallbackInCurrentRender = dashboardState === "fallback";

  // Fallback reconciliation: log when the fallback was previously shown but the
  // real schedule has now loaded successfully.
  useEffect(() => {
    if (showFallbackInCurrentRender) {
      fallbackWasShownRef.current = true;
    } else if (fallbackWasShownRef.current && dashboardState === "ready") {
      logObservabilityEvent("fallback_reconciled", { scope: "dashboard" });
      fallbackWasShownRef.current = false;
    }
  }, [showFallbackInCurrentRender, dashboardState]);

  if (dashboardState === "loading") {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-56" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (dashboardState === "error") {
    return (
      <div className="space-y-4" data-testid="dashboard-error">
        <h1 className="text-2xl font-bold tracking-tight">Today’s Mission</h1>
        <Card>
          <CardContent className="py-6 space-y-3">
            <p className="text-sm text-muted-foreground">
              We couldn’t load your latest mission yet. Please retry.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
                queryClient.invalidateQueries({ queryKey: getGetStudentProfileQueryKey() });
              }}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="space-y-4" data-testid="dashboard-empty-profile">
        <h1 className="text-2xl font-bold tracking-tight">Today’s Mission</h1>
        <Card>
          <CardContent className="py-6 space-y-3">
            <p className="text-sm text-muted-foreground">
              Your profile is not ready yet. Complete onboarding to generate your mission.
            </p>
            <Link href="/onboarding">
              <Button variant="outline">Go to onboarding</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const hasMission = hasTopics && Boolean(schedule) && scheduleBlocks.length > 0;
  const showFallbackMission = dashboardState === "fallback" && hasFallbackMission;
  const missionBlocksToRender: RenderMissionBlock[] = showFallbackMission
    ? fallbackMissionBlocks.map((block, index) => ({ block, index, status: "next", isFallback: true }))
    : numberedBlocks.map((entry) => ({ ...entry, isFallback: false }));
  const missionCtaHref = hasMission
    ? `/execute/${firstPendingIndex}`
    : showFallbackMission
      ? "/schedule"
      : hasTopics
        ? "/schedule"
        : "/topics";

  return (
    <div className="space-y-5" data-testid="dashboard">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Today’s Mission</h1>
        <p className="text-sm text-muted-foreground mt-1">Start now. The plan updates automatically tomorrow.</p>
      </div>

      {/* Identity anchoring — streak + consistency label */}
      {identity && (identity.streakDays > 0 || identity.daysStudiedThisWeek > 0) && (
        <Card className="border-emerald-200/60 bg-emerald-50/40 dark:border-emerald-800/40 dark:bg-emerald-950/20">
          <CardContent className="py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-base">{identityStreakIcon(identity.streakDays)}</span>
              <span className="font-medium text-emerald-800 dark:text-emerald-300">{identity.label}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground text-xs">{identity.showUpMessage}</span>
            </div>
            {identity.streakDays >= 1 && (
              <Badge variant="outline" className="shrink-0 text-xs border-emerald-400 text-emerald-700 dark:text-emerald-300">
                <Flame className="h-3 w-3 mr-1" />
                {identity.streakDays}d streak
              </Badge>
            )}
          </CardContent>
        </Card>
      )}

      {/* Re-entry mode banner */}
      {isReentryMode && (
        <Card className="border-blue-200/60 bg-blue-50/40 dark:border-blue-800/40 dark:bg-blue-950/20">
          <CardContent className="py-3 text-sm text-foreground flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <span>
              <span className="font-medium">Restart mode.</span>{" "}
              {emotionalFeedbackMsg || "Welcome back — just two short blocks today. No backlog carried forward."}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Low-capacity day banner */}
      {isLowCapacityMode && !isReentryMode && (
        <Card className="border-amber-200/60 bg-amber-50/40 dark:border-amber-800/40 dark:bg-amber-950/20">
          <CardContent className="py-3 text-sm text-foreground flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-amber-600 shrink-0" />
            {emotionalFeedbackMsg || "Recovery day — lighter plan prepared so you can rebuild without pressure."}
          </CardContent>
        </Card>
      )}

      {/* Standard reset banner */}
      {schedule?.isReset && !isReentryMode && !isLowCapacityMode && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="py-3 text-sm text-foreground flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-primary" />
            Fresh recovery mission prepared with a lighter target so you can rebuild momentum today.
          </CardContent>
        </Card>
      )}

      <Card className="border-primary/20">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <PlayCircle className="h-5 w-5 text-primary" />
            Execute now
          </CardTitle>
          <CardDescription>
            {showFallbackMission
              ? "Recovery mode mission · lightweight priority blocks while your full schedule reloads."
              : isReentryMode
              ? "Re-entry mission · just two easy wins to rebuild momentum"
              : hasMission
              ? `Target ${formatHoursFromMinutes(totalMinutes)}h · ${remainingMinutes} min left · ${paceBehind ? "Needs catch-up" : "On track"}`
              : "Your mission appears here automatically every day."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Progress value={completion} className="h-2" />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{completion}% complete</span>
            <span>{momentumLabel}</span>
          </div>

          {hasMission || showFallbackMission ? (
            <div className="space-y-2">
              {missionBlocksToRender.map(({ block, index, status, isFallback }) => {
                const badge = missionStatusBadge(status);
                return (
                  <div key={`${block.topicId}-${index}`} className="rounded-lg border px-3 py-2.5 bg-muted/20">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {index + 1}. {block.topicName}
                        </p>
                        <p className="text-xs text-muted-foreground">{block.durationMinutes}m · {block.sessionType}</p>
                      </div>
                      <Badge variant={badge.variant}>
                        {badge.label}
                      </Badge>
                    </div>
                    {!isFallback ? (
                      <details className="mt-2 text-xs text-muted-foreground">
                        <summary className="cursor-pointer hover:text-foreground">Why this topic?</summary>
                        <p className="mt-1 leading-relaxed">{blockReason(block)}</p>
                      </details>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Recovery mode pick to keep momentum while the full mission reloads.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border px-3 py-3 bg-muted/20 text-sm text-muted-foreground">
              {hasTopics
                ? "We’re preparing your sequence now. Open Schedule to recalculate if you changed topics."
                : "Add your first topics and your mission will appear here instantly."}
            </div>
          )}

          <Link href={missionCtaHref}>
            <Button className="w-full" data-testid="button-open-schedule-flow">
              {isReentryMode ? "Start Re-entry Session" : "Start Focused Session"}
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </Link>
          {!hasMission && !showFallbackMission && (
            <p className="text-xs text-muted-foreground">
              {hasTopics ? "Need a fresh mission? Recalculate once in Schedule." : "Add topics first, then launch your first focused session."}
            </p>
          )}
          {showFallbackMission && (
            <p className="text-xs text-muted-foreground">
              Fallback mode active. Use this minimal mission now, then retry full mission generation.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">What to do now</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {isColdStart ? (
            <div className="flex items-start gap-2" role="status" aria-live="polite">
              <Clock3 className="h-4 w-4 mt-0.5 text-muted-foreground" />
              <span>Too early to estimate — start building momentum with today’s first block.</span>
            </div>
          ) : (
            <div className="flex items-start gap-2" role="status" aria-live="polite">
              {hasMission && paceBehind
                ? <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
                : <Clock3 className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />}
              <span>
                {hasMission
                  ? forecastActionMsg
                  : "Set up today’s mission, then start your first focus block."}
              </span>
            </div>
          )}

          <div className="flex items-start gap-2">
            <CircleCheck className="h-4 w-4 mt-0.5 text-emerald-600 shrink-0" />
            <span>{interventionMessage(intervention)}</span>
          </div>

          {/* Confidence calibration hint */}
          {confidenceCalibration && confidenceCalibration.sessionTypeRecommendation !== "balanced" && (
            <div className="flex items-start gap-2 text-muted-foreground text-xs">
              <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                {confidenceCalibration.sessionTypeRecommendation === "more_practice"
                  ? "Confidence is running ahead of mastery on some topics — more practice sessions will close the gap."
                  : "You’re underestimating yourself on several topics — a few easy revision wins will recalibrate."}
              </span>
            </div>
          )}

          {/* Autonomy guard acknowledgment */}
          {autonomyEarned && (
            <div className="flex items-start gap-2 text-muted-foreground text-xs">
              <CircleCheck className="h-3.5 w-3.5 mt-0.5 text-emerald-500 shrink-0" />
              <span>Your consistency this week has earned more flexible swaps today.</span>
            </div>
          )}

          {(() => {
              const confidenceLevel =
                historicalSessionCount < COLD_START_SESSION_THRESHOLD
                  ? "Low"
                  : historicalSessionCount < MEDIUM_CONFIDENCE_SESSION_THRESHOLD
                  ? "Medium"
                  : "High";
              const confidenceMsg =
                historicalSessionCount < COLD_START_SESSION_THRESHOLD
                  ? `Insufficient data (stabilizes after ${COLD_START_SESSION_THRESHOLD}–7 days).`
                  : "Using observed behavior history.";
              return (
                <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
                  Forecast confidence: {confidenceLevel} · {confidenceMsg}
                </div>
              );
            })()}

          {(dashboardState === "fallback" || showFallbackMission) && (
            <Button
              variant="outline"
              onClick={() => {
                logObservabilityEvent("retry_requested", { scope: "dashboard" });
                resetMissionTimeout();
                queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
                queryClient.invalidateQueries({ queryKey: getGetStudentProfileQueryKey() });
              }}
            >
              Retry mission load
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Emotional feedback card — shown after any session progress */}
      {completion > 0 && emotionalFeedbackMsg && !isReentryMode && !isLowCapacityMode && (
        <Card className="bg-muted/20 border-dashed">
          <CardContent className="py-3 text-xs text-muted-foreground flex items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0" />
            {emotionalFeedbackMsg}
          </CardContent>
        </Card>
      )}

      <Card className="bg-muted/20 border-dashed">
        <CardContent className="py-3 text-xs text-muted-foreground flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0" />
          Open app → start focused session → keep your streak alive.
        </CardContent>
      </Card>
    </div>
  );
}
