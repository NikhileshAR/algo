import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
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

function formatHours(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export default function Review() {
  const { data, isLoading } = useQuery<WeeklyReview>({
    queryKey: ["analytics", "weekly-review"],
    queryFn: () => fetch("/api/analytics/weekly-review").then((r) => r.json()),
  });

  const weekStr = (() => {
    const today = new Date();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return `${weekAgo.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${today.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  })();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div><Skeleton className="h-8 w-48 mb-2" /><Skeleton className="h-4 w-32" /></div>
        <div className="grid gap-4 md:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!data) return null;

  const hoursDelta = data.totalHours - data.previousWeekHours;
  const consistencyDelta = data.daysWithStudy - data.previousWeekDaysWithStudy;
  const hasAnyStudy = data.totalMinutes > 0;

  return (
    <div className="space-y-6" data-testid="review-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Weekly Review</h1>
        <p className="text-muted-foreground">{weekStr}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Clock className="h-4 w-4" />Weekly Progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold">{formatHours(data.totalMinutes)}</p>
            <p className="text-xs text-muted-foreground">
              {hoursDelta >= 0 ? `+${hoursDelta.toFixed(1)}h vs last week` : `${hoursDelta.toFixed(1)}h vs last week`}
            </p>
            <p className="text-xs text-muted-foreground">{data.weeklySessions.length} sessions across {data.daysWithStudy}/7 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><TrendingUp className="h-4 w-4" />Behavioral Insight</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.skippedPracticeSessions ? (
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

            {data.consistencyDroppedMidWeek ? (
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
                  {data.recoveryDays > 0
                    ? `You recovered in ${data.recoveryDays} day${data.recoveryDays === 1 ? "" : "s"} after a break.`
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
            <BarChart data={data.dailyHours}>
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
