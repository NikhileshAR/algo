import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetStudentProfile, useListSessions, useListTopics, type DailySchedule } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getValidationRepo, runValidationPipeline } from "@/lib/local-db/validation";
import { scheduleEndpointForMode, useValidationMode } from "@/lib/validation-mode";
import type { WeeklyValidationSummaryRecord } from "@/lib/local-db/schema";

function isoDay(date = new Date()): string {
  return date.toISOString().split("T")[0];
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function comparisonLabel(current: number, previous: number, unit = ""): string {
  if (current > previous) return `You studied more than last week (+${(current - previous).toFixed(1)}${unit}).`;
  if (current < previous) return `You studied less than last week (${(current - previous).toFixed(1)}${unit}).`;
  return "You studied about the same as last week.";
}

function recoveryLabel(current: number | null, previous: number | null): string {
  if (current === null || previous === null) return "Not enough recovery events yet for speed comparison.";
  if (current < previous) return "You recovered faster than last week.";
  if (current > previous) return "You recovered slower than last week.";
  return "Recovery speed is unchanged from last week.";
}

export default function Review() {
  const [mode] = useValidationMode();
  const today = isoDay();
  const { data: profile } = useGetStudentProfile();
  const { data: topics } = useListTopics();
  const { data: sessions } = useListSessions({ limit: 400 });
  const { data: schedule } = useQuery<DailySchedule>({
    queryKey: ["schedule", "today", mode],
    queryFn: () => fetch(scheduleEndpointForMode(mode)).then((r) => r.json()),
  });
  const [summaries, setSummaries] = useState<WeeklyValidationSummaryRecord[]>([]);

  useEffect(() => {
    if (!profile || !topics || !sessions || !schedule) return;
    const actualHours = sessions
      .filter((s) => typeof s.studiedAt === "string" && s.studiedAt.startsWith(today))
      .reduce((sum, s) => sum + s.durationMinutes / 60, 0);
    const sessionsCompleted = sessions.filter((s) => typeof s.studiedAt === "string" && s.studiedAt.startsWith(today)).length;
    const weightedNow = topics.length > 0
      ? topics.reduce((sum, topic) => sum + topic.masteryScore * Math.max(topic.priorityScore, 0.01), 0) /
        topics.reduce((sum, topic) => sum + Math.max(topic.priorityScore, 0.01), 0)
      : 0;
    const backlogLevel = schedule.scheduledHours > 0
      ? Math.max(0, Math.min(1, 1 - actualHours / schedule.scheduledHours))
      : 0;
    void runValidationPipeline({
      mode,
      date: today,
      plannedHours: schedule.scheduledHours ?? 0,
      actualHours,
      sessionsCompleted,
      resetTriggered: Boolean(schedule.isReset),
      disciplineScore: profile.disciplineScore,
      capacityEstimate: profile.capacityScore,
      highPriorityProgress: weightedNow,
      backlogLevel,
    }).then(async () => {
      const rows = await getValidationRepo().weeklySummaries();
      setSummaries(rows);
    });
  }, [mode, profile, topics, sessions, schedule, today]);

  useEffect(() => {
    void getValidationRepo().weeklySummaries().then((rows) => setSummaries(rows));
  }, [mode]);

  const modeSummaries = useMemo(
    () => summaries.filter((s) => s.mode === mode).sort((a, b) => b.week_end.localeCompare(a.week_end)),
    [summaries, mode],
  );
  const current = modeSummaries[0] ?? null;
  const previous = modeSummaries[1] ?? null;
  const baseline = useMemo(
    () => summaries.find((s) => s.mode === "baseline"),
    [summaries],
  );

  if (!current) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-44" />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="review-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Weekly Validation</h1>
        <p className="text-muted-foreground text-sm">Mode: {mode}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Weekly summary card</CardTitle>
          <CardDescription>
            {current.week_start} → {current.week_end}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Total study hours: <span className="font-medium">{current.total_study_hours.toFixed(1)}h</span></p>
          <p>Average completion rate: <span className="font-medium">{pct(current.average_completion_rate)}</span></p>
          <p>Consistency: <span className="font-medium">{pct(current.consistency)}</span></p>
          <p>Session completion: <span className="font-medium">{pct(current.average_session_completion_pct)}</span></p>
          <p>Resets triggered: <span className="font-medium">{current.resets_triggered}</span></p>
          <p>Recovery after reset: <span className="font-medium">{current.recovery_after_reset_days ?? "—"} days</span></p>
          <p>Capacity trend: <span className="font-medium">{current.capacity_trend}</span></p>
          <p>High-priority progress: <span className="font-medium">{current.high_priority_progress !== null ? pct(current.high_priority_progress) : "—"}</span></p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-2 text-sm">
          <p>{previous ? comparisonLabel(current.total_study_hours, previous.total_study_hours, "h") : "Need one more week to compare study hours."}</p>
          <p>{previous ? recoveryLabel(current.recovery_after_failure_days, previous.recovery_after_failure_days) : "Need one more week to compare recovery speed."}</p>
          {mode === "adaptive" && baseline && (
            <p>
              Adaptive vs baseline consistency:{" "}
              <span className="font-medium">
                {(current.consistency - baseline.consistency >= 0 ? "+" : "") + (current.consistency - baseline.consistency).toFixed(2)}
              </span>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
