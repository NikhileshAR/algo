import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import {
  CheckCircle2,
  AlertTriangle,
  Flame,
  Clock,
  BookOpen,
  FlaskConical,
  TrendingUp,
  Target,
  Lightbulb,
  CalendarDays,
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
  practiceCount: number;
  lectureCount: number;
  daysWithStudy: number;
  subjectBreakdown: Array<{ subject: string; minutes: number }>;
  neglectedTopics: Array<{ id: number; name: string; subject: string; masteryScore: number }>;
  lowestMastery: Array<{ id: number; name: string; subject: string; masteryScore: number }>;
  averageMastery: number;
  totalTopics: number;
  completedTopics: number;
}

const CHART_COLORS = ["#1b6b7a", "#4a9daa", "#7bc3cc", "#aadde3", "#cceef1", "#a0616a", "#d4a99a"];

function formatHours(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function hourLabel(h: number) {
  if (h === 0) return "12am";
  if (h < 12) return `${h}am`;
  if (h === 12) return "12pm";
  return `${h - 12}pm`;
}

function Recommendation({
  icon: Icon,
  type,
  text,
}: { icon: React.ElementType; type: "good" | "warn" | "info"; text: string }) {
  const styles = {
    good: "bg-emerald-50 border-emerald-200 text-emerald-900",
    warn: "bg-amber-50 border-amber-200 text-amber-900",
    info: "bg-blue-50 border-blue-200 text-blue-900",
  };
  return (
    <div className={`flex items-start gap-2.5 text-sm rounded-lg border px-3 py-2.5 ${styles[type]}`}>
      <Icon className="h-4 w-4 shrink-0 mt-0.5" />
      <span>{text}</span>
    </div>
  );
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
        <div className="grid gap-4 md:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!data) return null;

  const recommendations: Array<{ icon: React.ElementType; type: "good" | "warn" | "info"; text: string }> = [];

  if (data.totalHours >= 10) {
    recommendations.push({ icon: Flame, type: "good", text: `Strong week — ${data.totalHours.toFixed(1)}h logged. Maintain this pace heading into the next block.` });
  } else if (data.totalHours >= 5) {
    recommendations.push({ icon: TrendingUp, type: "info", text: `${data.totalHours.toFixed(1)}h this week. Aim to add 20% more next week to build momentum.` });
  } else {
    recommendations.push({ icon: AlertTriangle, type: "warn", text: `Only ${data.totalHours.toFixed(1)}h studied this week. Consistent daily sessions compound faster than weekend bursts.` });
  }

  if (data.daysWithStudy < 4) {
    recommendations.push({ icon: CalendarDays, type: "warn", text: `Study spread: ${data.daysWithStudy}/7 days. Try to study at least 5 days/week — consistency beats volume.` });
  }

  if (data.neglectedTopics.length > 0) {
    const topNeglected = data.neglectedTopics.slice(0, 2).map((t) => t.name).join(", ");
    recommendations.push({ icon: AlertTriangle, type: "warn", text: `Neglected this week: ${topNeglected}. These topics are losing ground to the forgetting curve.` });
  }

  if (data.lowestMastery.length > 0) {
    const lowest = data.lowestMastery[0];
    recommendations.push({ icon: Target, type: "info", text: `${lowest.name} has the lowest mastery at ${Math.round(lowest.masteryScore * 100)}%. Schedule extra time on it next week.` });
  }

  if (data.practiceCount === 0 && data.lectureCount > 0) {
    recommendations.push({ icon: FlaskConical, type: "warn", text: "No practice sessions this week — all lectures. Practice questions are essential for exam prep; aim for 30% practice sessions." });
  }

  const practiceRatio = data.weeklySessions.length > 0 ? data.practiceCount / data.weeklySessions.length : 0;
  if (practiceRatio >= 0.4) {
    recommendations.push({ icon: CheckCircle2, type: "good", text: `Good balance: ${Math.round(practiceRatio * 100)}% practice sessions. Active retrieval is the most efficient study method.` });
  }

  const daysOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayBreakdown = daysOfWeek.map((day, i) => {
    const sessions = data.weeklySessions.filter((s) => new Date(s.studiedAt).getDay() === i);
    return {
      day,
      minutes: sessions.reduce((acc, s) => acc + s.durationMinutes, 0),
      sessions: sessions.length,
    };
  });

  return (
    <div className="space-y-6" data-testid="review-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Weekly Review</h1>
        <p className="text-muted-foreground">{weekStr}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {[
          { label: "Total study time", value: formatHours(data.totalMinutes), icon: Clock, sub: `${data.weeklySessions.length} sessions` },
          { label: "Days studied", value: `${data.daysWithStudy}/7`, icon: CalendarDays, sub: data.daysWithStudy >= 5 ? "Great consistency" : "Aim for 5+ days" },
          { label: "Practice sessions", value: data.practiceCount, icon: FlaskConical, sub: `${data.lectureCount} lectures` },
          { label: "Average mastery", value: `${Math.round(data.averageMastery * 100)}%`, icon: Target, sub: `${data.completedTopics}/${data.totalTopics} complete` },
        ].map(({ label, value, icon: Icon, sub }) => (
          <Card key={label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{value}</div>
              <p className="text-xs text-muted-foreground mt-1">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Study by Day</CardTitle>
            <CardDescription>Minutes studied per day this week</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={dayBreakdown}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="day" tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                  formatter={(v: number) => [`${v}m`, "Minutes"]}
                />
                <Bar dataKey="minutes" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {data.subjectBreakdown.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Time by Subject</CardTitle>
              <CardDescription>How your study time was distributed</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={data.subjectBreakdown} dataKey="minutes" nameKey="subject" cx="50%" cy="50%" outerRadius={70} label={({ subject, percent }) => `${subject} ${Math.round(percent * 100)}%`} labelLine={false} fontSize={10}>
                    {data.subjectBreakdown.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => [formatHours(v), "Time"]} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }} />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex items-center justify-center h-full min-h-[200px] text-muted-foreground text-sm">
              No sessions logged this week.
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-primary" />
            Recommendations for next week
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {recommendations.map((r, i) => (
            <Recommendation key={i} icon={r.icon} type={r.type} text={r.text} />
          ))}
        </CardContent>
      </Card>

      {data.neglectedTopics.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Not studied this week</CardTitle>
            <CardDescription>These topics may be losing ground to forgetting — prioritize them next week.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.neglectedTopics.map((t) => (
              <div key={t.id} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <Badge variant="outline" className="text-xs">{t.subject}</Badge>
                  </div>
                  <span className="text-muted-foreground text-xs">{Math.round(t.masteryScore * 100)}% mastery</span>
                </div>
                <Progress value={t.masteryScore * 100} className="h-1.5" />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {data.weeklySessions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">This week's sessions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.weeklySessions.slice(0, 20).map((s) => (
                <div key={s.id} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div className="flex items-center gap-2">
                    {s.sessionType === "practice" ? <FlaskConical className="h-4 w-4 text-primary" /> : <BookOpen className="h-4 w-4 text-muted-foreground" />}
                    <div>
                      <p className="text-sm font-medium">{s.topicName}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(s.studiedAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                        {s.testScore !== null && s.testScoreMax !== null && ` · ${Math.round((s.testScore / s.testScoreMax) * 100)}%`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={s.sessionType === "practice" ? "default" : "secondary"} className="text-xs">{s.sessionType}</Badge>
                    <span className="text-sm text-muted-foreground">{s.durationMinutes}m</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
