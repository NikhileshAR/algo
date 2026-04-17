import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  useGetDashboardSummary,
  useGetWeeklyProgress,
  useGetPriorityTopics,
  useGetTodaySchedule,
  useGetStudentProfile,
  useListTopics,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import {
  CalendarDays,
  TrendingUp,
  Target,
  Flame,
  BookOpen,
  Clock,
  Lightbulb,
  CheckCircle2,
  Circle,
  X,
  AlertTriangle,
  Zap,
  ArrowRight,
  Activity,
} from "lucide-react";

function StatCard({ title, value, description, icon: Icon }: { title: string; value: string | number; description?: string; icon: React.ElementType }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid={`stat-${title.toLowerCase().replace(/\s/g, "-")}`}>{value}</div>
        {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      </CardContent>
    </Card>
  );
}

type InsightType = "warn" | "good" | "urgent" | "info" | "action";
interface Insight { type: InsightType; text: string; }

function NarrativeInsights({
  summary,
  schedule,
  topicsCount,
  velocity,
  studyPatterns,
}: {
  summary: { disciplineScore: number; capacityScore?: number; averageMastery: number; daysUntilExam: number; weeklyStudiedHours: number };
  schedule?: { blocks: Array<{ topicName: string; durationMinutes: number; sessionType: string; masteryScore: number }> } | null;
  topicsCount: number;
  velocity?: Array<{ subject: string; velocityPerSession: number | null; averageMastery: number }>;
  studyPatterns?: { peakHour: number | null; totalSessions: number };
}) {
  const insights: Insight[] = [];
  const D = summary.disciplineScore;
  const K = summary.capacityScore ?? 0;
  const days = summary.daysUntilExam;

  if (D < 0.35) {
    insights.push({ type: "warn", text: `Discipline is at ${Math.round(D * 100)}% — you've been studying less than planned. Today's schedule is lighter to help rebuild momentum.` });
  } else if (D >= 0.8) {
    insights.push({ type: "good", text: `Discipline at ${Math.round(D * 100)}% — excellent consistency. The algorithm is progressively expanding your scheduled hours as your capacity grows.` });
  } else {
    insights.push({ type: "info", text: `Discipline at ${Math.round(D * 100)}% — roughly on track. Hitting each block consistently will raise your score and unlock longer study days.` });
  }

  if (K > 0 && K < 1.5) {
    insights.push({ type: "warn", text: `Capacity is low at ${K.toFixed(1)}h/day — this recovers geometrically as you complete sessions. A few consistent days will open up longer blocks.` });
  }

  if (days > 0 && days < 14) {
    insights.push({ type: "urgent", text: `Exam is in ${days} days — entering final sprint mode. Focus on your highest-mastery topics to maximise what you can consolidate before the date.` });
  } else if (days > 0 && days < 30) {
    insights.push({ type: "info", text: `${days} days remaining — entering the critical revision window. The scheduler will start prioritising practice sessions over new lecture material.` });
  }

  // Per-subject velocity insight (#13)
  if (velocity && velocity.length >= 2) {
    const withVelocity = velocity.filter((v) => v.velocityPerSession !== null);
    if (withVelocity.length >= 2) {
      const fastest = withVelocity[0];
      const slowest = withVelocity[withVelocity.length - 1];
      if (fastest.subject !== slowest.subject) {
        insights.push({
          type: "info",
          text: `Learning velocity: ${fastest.subject} is improving fastest (${Math.round((fastest.velocityPerSession ?? 0) * 100)}% mastery/session). ${slowest.subject} is gaining slower — allocate more practice time there.`,
        });
      }
    }
  }

  // Time-of-day insight (#15)
  if (studyPatterns?.peakHour !== null && studyPatterns?.peakHour !== undefined && studyPatterns.totalSessions >= 3) {
    const h = studyPatterns.peakHour;
    const label = h === 0 ? "midnight" : h < 12 ? `${h}am` : h === 12 ? "noon" : `${h - 12}pm`;
    insights.push({ type: "good", text: `Your most productive study window is around ${label} — that's when you've logged the most time. Protect that slot.` });
  }

  if (topicsCount === 0) {
    insights.push({ type: "action", text: "Add your exam topics in the Topics section — the scheduler needs them to build your personalized daily plan." });
  } else if (!schedule?.blocks?.length) {
    insights.push({ type: "action", text: "Go to Schedule and hit Recalculate to generate today's study plan based on your current state." });
  } else {
    const first = schedule.blocks[0];
    insights.push({ type: "action", text: `Today's first block: ${first.topicName} (${first.durationMinutes}min ${first.sessionType}) — current mastery ${Math.round(first.masteryScore * 100)}%.` });
  }

  const insightStyles: Record<InsightType, string> = {
    warn: "bg-amber-50 border-amber-200 text-amber-900",
    good: "bg-emerald-50 border-emerald-200 text-emerald-900",
    urgent: "bg-red-50 border-red-200 text-red-900",
    info: "bg-blue-50 border-blue-200 text-blue-900",
    action: "bg-primary/5 border-primary/20 text-foreground",
  };

  const insightIcons: Record<InsightType, React.ElementType> = {
    warn: AlertTriangle,
    good: Flame,
    urgent: Zap,
    info: Lightbulb,
    action: ArrowRight,
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-primary" />
          What the system sees
        </CardTitle>
        <CardDescription className="text-xs">Live read-out of your stochastic state vector</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {insights.map((insight, i) => {
          const Icon = insightIcons[insight.type];
          return (
            <div key={i} className={`flex items-start gap-2.5 text-sm rounded-lg border px-3 py-2.5 ${insightStyles[insight.type]}`}>
              <Icon className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{insight.text}</span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function GettingStartedChecklist({ topicsCount, hasSchedule, hasStudied, onDismiss }: { topicsCount: number; hasSchedule: boolean; hasStudied: boolean; onDismiss: () => void }) {
  const steps = [
    { done: true, label: "Set up your profile" },
    { done: topicsCount >= 3, label: `Add at least 3 topics (${topicsCount}/3 added)` },
    { done: hasSchedule, label: "Generate your first schedule — go to Schedule and hit Recalculate" },
    { done: hasStudied, label: "Log your first study session" },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  if (completedCount === steps.length) return null;

  return (
    <Card className="border-primary/25 bg-primary/5">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Getting started</CardTitle>
          <button onClick={onDismiss} className="text-muted-foreground hover:text-foreground transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center" aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
        <CardDescription className="text-xs">Complete these steps to activate the adaptive scheduler ({completedCount}/{steps.length} done)</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-2.5 text-sm">
            {step.done ? <CheckCircle2 className="h-4 w-4 text-primary shrink-0" /> : <Circle className="h-4 w-4 text-muted-foreground shrink-0" />}
            <span className={step.done ? "line-through text-muted-foreground" : "text-foreground"}>{step.label}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const [checklistDismissed, setChecklistDismissed] = useState(() => localStorage.getItem("sf_checklist_dismissed") === "1");

  const { data: profile, isError: profileError, isLoading: profileLoading } = useGetStudentProfile({ query: { retry: false } });
  const { data: summary, isLoading: summaryLoading } = useGetDashboardSummary();
  const { data: weeklyProgress, isLoading: weeklyLoading } = useGetWeeklyProgress();
  const { data: priorityTopics, isLoading: topicsLoading } = useGetPriorityTopics();
  const { data: schedule } = useGetTodaySchedule();
  const { data: allTopics } = useListTopics();

  const { data: velocity } = useQuery<Array<{ subject: string; velocityPerSession: number | null; averageMastery: number }>>({
    queryKey: ["analytics", "velocity"],
    queryFn: () => fetch("/api/analytics/velocity").then((r) => r.json()),
    enabled: (allTopics?.length ?? 0) > 0,
  });

  const { data: studyPatterns } = useQuery<{ peakHour: number | null; totalSessions: number }>({
    queryKey: ["analytics", "study-patterns"],
    queryFn: () => fetch("/api/analytics/study-patterns").then((r) => r.json()),
    enabled: (summary?.weeklyStudiedHours ?? 0) > 0,
  });

  useEffect(() => {
    if (!profileLoading && profileError) setLocation("/onboarding");
  }, [profileLoading, profileError, setLocation]);

  if (profileLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
      </div>
    );
  }

  if (!profile) return null;

  const disciplinePercent = Math.round((summary?.disciplineScore ?? 0) * 100);
  const masteryPercent = Math.round((summary?.averageMastery ?? 0) * 100);
  const completionPercent = summary && summary.totalTopics > 0 ? Math.round((summary.completedTopics / summary.totalTopics) * 100) : 0;

  const chartData = Array.isArray(weeklyProgress) ? weeklyProgress.map((d) => ({
    date: new Date(d.date).toLocaleDateString("en-US", { weekday: "short" }),
    studied: Math.round(d.studiedHours * 10) / 10,
    scheduled: Math.round(d.scheduledHours * 10) / 10,
  })) : [];

  const topicsCount = allTopics?.length ?? 0;
  const scheduleBlocks = Array.isArray(schedule?.blocks) ? schedule.blocks : [];
  const scheduleHours = typeof schedule?.scheduledHours === "number" ? schedule.scheduledHours : 0;
  const normalizedSchedule = schedule && Array.isArray(schedule.blocks) ? { ...schedule, blocks: scheduleBlocks } : null;
  const hasSchedule = scheduleBlocks.length > 0;
  const hasStudied = (summary?.weeklyStudiedHours ?? 0) > 0;
  const showChecklist = !checklistDismissed && (!hasStudied || topicsCount < 3 || !hasSchedule);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();

  return (
    <div className="space-y-6" data-testid="dashboard">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{greeting}, {profile.name}</h1>
        <div className="text-muted-foreground text-sm mt-1">
          {summary ? <>{summary.daysUntilExam} days until <span className="font-medium text-foreground">{summary.examName}</span></> : <Skeleton className="h-4 w-48 inline-block" />}
        </div>
      </div>

      {showChecklist && (
        <GettingStartedChecklist topicsCount={topicsCount} hasSchedule={hasSchedule} hasStudied={hasStudied} onDismiss={() => { localStorage.setItem("sf_checklist_dismissed", "1"); setChecklistDismissed(true); }} />
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {summaryLoading ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />) : (
          <>
            <StatCard title="Days Until Exam" value={summary?.daysUntilExam ?? "—"} description={summary?.examDate} icon={CalendarDays} />
            <StatCard title="Discipline Score" value={`${disciplinePercent}%`} description="Actual vs scheduled study ratio" icon={TrendingUp} />
            <StatCard title="Average Mastery" value={`${masteryPercent}%`} description={`${summary?.completedTopics ?? 0}/${summary?.totalTopics ?? 0} topics complete`} icon={Target} />
            <StatCard title="Study Streak" value={`${summary?.streakDays ?? 0} days`} description={`${summary?.weeklyStudiedHours ?? 0}h this week`} icon={Flame} />
          </>
        )}
      </div>

      {summary && !summaryLoading && (
        <NarrativeInsights summary={summary} schedule={normalizedSchedule} topicsCount={topicsCount} velocity={velocity} studyPatterns={studyPatterns} />
      )}

      {velocity && velocity.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              Learning Velocity by Subject
            </CardTitle>
            <CardDescription className="text-xs">Average mastery gain per practice session — where your effort is paying off</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {velocity.map((v) => (
              <div key={v.subject} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{v.subject}</span>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {v.velocityPerSession !== null ? (
                      <span className={`font-medium ${v.velocityPerSession >= 0.05 ? "text-emerald-700" : v.velocityPerSession >= 0.02 ? "text-amber-700" : "text-muted-foreground"}`}>
                        +{Math.round(v.velocityPerSession * 100)}%/session
                      </span>
                    ) : (
                      <span className="text-muted-foreground italic">no practice yet</span>
                    )}
                    <span>{Math.round(v.averageMastery * 100)}% avg mastery</span>
                  </div>
                </div>
                <Progress value={v.averageMastery * 100} className="h-1.5" />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Weekly Progress</CardTitle>
            <CardDescription>Studied vs scheduled hours per day</CardDescription>
          </CardHeader>
          <CardContent>
            {weeklyLoading ? <Skeleton className="h-48" /> : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }} />
                  <Legend wrapperStyle={{ fontSize: "12px" }} />
                  <Bar dataKey="studied" name="Studied" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="scheduled" name="Scheduled" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} opacity={0.5} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Priority Topics</CardTitle>
            <CardDescription>Highest urgency — study these next</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {topicsLoading ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />) : priorityTopics && priorityTopics.length > 0 ? (
              priorityTopics.map((topic) => (
                <div key={topic.id} className="space-y-1" data-testid={`priority-topic-${topic.id}`}>
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{topic.name}</span>
                      <Badge variant="outline" className="text-xs py-0">{topic.subject}</Badge>
                    </div>
                    <span className="text-muted-foreground text-xs">{Math.round(topic.masteryScore * 100)}%</span>
                  </div>
                  <Progress value={topic.masteryScore * 100} className="h-1.5" />
                </div>
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                <BookOpen className="h-8 w-8 mb-2 opacity-40" />
                <p className="text-sm">No topics yet. Add topics to get started.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {hasSchedule && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Today's Schedule</CardTitle>
            <CardDescription>{scheduleHours.toFixed(1)}h planned — {scheduleBlocks.length} blocks</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {scheduleBlocks.map((block, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border px-3 py-2 bg-muted/30" data-testid={`schedule-block-${i}`}>
                  <div className="flex items-center gap-3">
                    <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-sm font-medium">{block.topicName}</p>
                      <p className="text-xs text-muted-foreground">{block.subject}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={block.sessionType === "practice" ? "default" : "secondary"}>{block.sessionType}</Badge>
                    <span className="text-sm text-muted-foreground">{block.durationMinutes}m</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">System State</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { label: "Discipline (D)", value: `${disciplinePercent}%`, percent: disciplinePercent },
              { label: "Capacity (K)", value: `${summary?.capacityScore?.toFixed(1) ?? 0}h/day`, percent: Math.min(((summary?.capacityScore ?? 0) / 12) * 100, 100) },
              { label: "Overall Mastery (M)", value: `${masteryPercent}%`, percent: masteryPercent },
              { label: "Completion", value: `${completionPercent}%`, percent: completionPercent },
            ].map(({ label, value, percent }) => (
              <div key={label} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span>{label}</span>
                  <span className="text-muted-foreground">{value}</span>
                </div>
                <Progress value={percent} className="h-2" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
