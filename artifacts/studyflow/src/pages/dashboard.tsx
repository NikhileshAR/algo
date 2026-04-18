import { useEffect, useMemo } from "react";
import { useLocation, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  useGetStudentProfile,
  getGetStudentProfileQueryKey,
  useListSessions,
  useListTopics,
  type DailySchedule,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, Clock3, CircleCheck, PlayCircle, AlertTriangle, RefreshCw, Sparkles } from "lucide-react";

type RiskSignal = {
  backlogRisk: number;
  fallingBehind: boolean;
  intervention: "none" | "reduced_targets" | "priority_concentration" | "early_reset";
};

type ControlSnapshot = {
  forecast?: {
    expectedCoverageByExamDate?: number;
    riskSignal?: RiskSignal;
  };
  performanceGap?: {
    studyHoursDeviation?: number;
  };
};

type ExtendedSchedule = DailySchedule & {
  riskSignal?: RiskSignal;
  control?: ControlSnapshot;
};

const EXPLANATION_DISPLAY_THRESHOLD = 0.5;
const STRONG_MOMENTUM_MINUTES = 90;
const ALMOST_THERE_MINUTES = 60;
const MIN_CATCHUP_HOURS = 0.5;

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

  const { data: profile, isError: profileError, isLoading: profileLoading } = useGetStudentProfile({
    query: { queryKey: getGetStudentProfileQueryKey(), retry: false },
  });
  const { data: topics } = useListTopics();
  const { data: sessions } = useListSessions({ limit: 200 });

  const { data: scheduleWithControl, isLoading: scheduleLoading } = useQuery<ExtendedSchedule>({
    queryKey: ["schedule", "today", "extended"],
    queryFn: () => fetch("/api/schedule/today").then((r) => r.json()),
    refetchInterval: 10000,
  });

  useEffect(() => {
    if (!profileLoading && profileError) {
      setLocation("/onboarding");
    }
  }, [profileLoading, profileError, setLocation]);

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

  if (profileLoading || scheduleLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-56" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (!profile) {
    return null;
  }

  const hasTopics = (topics?.length ?? 0) > 0;
  const hasMission = hasTopics && Boolean(schedule) && scheduleBlocks.length > 0;

  return (
    <div className="space-y-5" data-testid="dashboard">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Today’s Mission</h1>
        <p className="text-sm text-muted-foreground mt-1">Start now. The plan updates automatically tomorrow.</p>
      </div>

      {schedule?.isReset && (
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
            {hasMission
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

          {hasMission ? (
            <div className="space-y-2">
              {numberedBlocks.map(({ block, index, status }) => {
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
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer hover:text-foreground">Why this topic?</summary>
                      <p className="mt-1 leading-relaxed">{blockReason(block)}</p>
                    </details>
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

          <Link href={hasMission ? `/execute/${firstPendingIndex}` : hasTopics ? "/schedule" : "/topics"}>
            <Button className="w-full" data-testid="button-open-schedule-flow">
              Start Focused Session
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </Link>
          {!hasMission && (
            <p className="text-xs text-muted-foreground">
              {hasTopics ? "Need a fresh mission? Recalculate once in Schedule." : "Add topics first, then launch your first focused session."}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">What to do now</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {hasMission && paceBehind ? (
            <div className="flex items-start gap-2" role="status" aria-live="polite">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600" />
              <span>At your current pace, you may not complete the syllabus on time.</span>
            </div>
          ) : (
            <div className="flex items-start gap-2" role="status" aria-live="polite">
              <Clock3 className="h-4 w-4 mt-0.5 text-muted-foreground" />
              <span>{hasMission ? "You are on pace. Keep following today’s sequence." : "Set up today’s mission, then start your first focus block."}</span>
            </div>
          )}

          {hasMission && paceBehind && (
            <div className="flex items-start gap-2" role="status" aria-live="polite">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600" />
              <span>You need about <span className="font-medium">+{suggestedCatchupHours.toFixed(1)} hours/day</span> this week to stay on track.</span>
            </div>
          )}

          <div className="flex items-start gap-2">
            <CircleCheck className="h-4 w-4 mt-0.5 text-emerald-600" />
            <span>{interventionMessage(intervention)}</span>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-muted/20 border-dashed">
        <CardContent className="py-3 text-xs text-muted-foreground flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          Open app → start focused session → keep your streak alive.
        </CardContent>
      </Card>
    </div>
  );
}
