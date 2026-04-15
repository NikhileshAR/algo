import { useEffect } from "react";
import { useLocation } from "wouter";
import {
  useGetDashboardSummary,
  useGetWeeklyProgress,
  useGetPriorityTopics,
  useGetTodaySchedule,
  useGetStudentProfile,
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
import { CalendarDays, TrendingUp, Target, Clock, Flame, BookOpen } from "lucide-react";

function StatCard({
  title,
  value,
  description,
  icon: Icon,
}: {
  title: string;
  value: string | number;
  description?: string;
  icon: React.ElementType;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid={`stat-${title.toLowerCase().replace(/\s/g, "-")}`}>
          {value}
        </div>
        {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { data: profile, isError: profileError, isLoading: profileLoading } = useGetStudentProfile({
    query: { retry: false },
  });
  const { data: summary, isLoading: summaryLoading } = useGetDashboardSummary();
  const { data: weeklyProgress, isLoading: weeklyLoading } = useGetWeeklyProgress();
  const { data: priorityTopics, isLoading: topicsLoading } = useGetPriorityTopics();
  const { data: schedule } = useGetTodaySchedule();

  useEffect(() => {
    if (!profileLoading && profileError) {
      setLocation("/onboarding");
    }
  }, [profileLoading, profileError, setLocation]);

  if (profileLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  if (!profile) return null;

  const disciplinePercent = Math.round((summary?.disciplineScore ?? 0) * 100);
  const masteryPercent = Math.round((summary?.averageMastery ?? 0) * 100);
  const completionPercent =
    summary && summary.totalTopics > 0
      ? Math.round((summary.completedTopics / summary.totalTopics) * 100)
      : 0;

  const chartData =
    weeklyProgress?.map((d) => ({
      date: new Date(d.date).toLocaleDateString("en-US", { weekday: "short" }),
      studied: Math.round(d.studiedHours * 10) / 10,
      scheduled: Math.round(d.scheduledHours * 10) / 10,
    })) ?? [];

  return (
    <div className="space-y-6" data-testid="dashboard">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Good morning, {profile.name}</h1>
        <p className="text-muted-foreground">
          {summary ? (
            <>
              {summary.daysUntilExam} days until{" "}
              <span className="font-medium text-foreground">{summary.examName}</span>
            </>
          ) : (
            <Skeleton className="h-4 w-48 inline-block" />
          )}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {summaryLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)
        ) : (
          <>
            <StatCard
              title="Days Until Exam"
              value={summary?.daysUntilExam ?? "—"}
              description={summary?.examDate}
              icon={CalendarDays}
            />
            <StatCard
              title="Discipline Score"
              value={`${disciplinePercent}%`}
              description="Actual vs scheduled study ratio"
              icon={TrendingUp}
            />
            <StatCard
              title="Average Mastery"
              value={`${masteryPercent}%`}
              description={`${summary?.completedTopics ?? 0}/${summary?.totalTopics ?? 0} topics complete`}
              icon={Target}
            />
            <StatCard
              title="Study Streak"
              value={`${summary?.streakDays ?? 0} days`}
              description={`${summary?.weeklyStudiedHours ?? 0}h this week`}
              icon={Flame}
            />
          </>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Weekly Progress</CardTitle>
            <CardDescription>Studied vs scheduled hours per day</CardDescription>
          </CardHeader>
          <CardContent>
            {weeklyLoading ? (
              <Skeleton className="h-48" />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                      fontSize: "12px",
                    }}
                  />
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
            {topicsLoading ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)
            ) : priorityTopics && priorityTopics.length > 0 ? (
              priorityTopics.map((topic) => (
                <div key={topic.id} className="space-y-1" data-testid={`priority-topic-${topic.id}`}>
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{topic.name}</span>
                      <Badge variant="outline" className="text-xs py-0">
                        {topic.subject}
                      </Badge>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {Math.round(topic.masteryScore * 100)}%
                    </span>
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

      {schedule && schedule.blocks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Today's Schedule</CardTitle>
            <CardDescription>
              {schedule.scheduledHours.toFixed(1)}h planned — {schedule.blocks.length} blocks
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {schedule.blocks.map((block, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg border px-3 py-2 bg-muted/30"
                  data-testid={`schedule-block-${i}`}
                >
                  <div className="flex items-center gap-3">
                    <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-sm font-medium">{block.topicName}</p>
                      <p className="text-xs text-muted-foreground">{block.subject}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={block.sessionType === "practice" ? "default" : "secondary"}>
                      {block.sessionType}
                    </Badge>
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
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span>Discipline (D)</span>
                <span className="text-muted-foreground">{disciplinePercent}%</span>
              </div>
              <Progress value={disciplinePercent} className="h-2" />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span>Capacity (K)</span>
                <span className="text-muted-foreground">{summary?.capacityScore?.toFixed(1) ?? 0}h/day</span>
              </div>
              <Progress value={Math.min(((summary?.capacityScore ?? 0) / 12) * 100, 100)} className="h-2" />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span>Overall Mastery (M)</span>
                <span className="text-muted-foreground">{masteryPercent}%</span>
              </div>
              <Progress value={masteryPercent} className="h-2" />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span>Completion</span>
                <span className="text-muted-foreground">{completionPercent}%</span>
              </div>
              <Progress value={completionPercent} className="h-2" />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
