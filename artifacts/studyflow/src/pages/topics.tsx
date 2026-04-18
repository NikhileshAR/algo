import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useListTopics,
  useCreateTopic,
  useUpdateTopic,
  useDeleteTopic,
  useGetDashboardSummary,
  getListTopicsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetPriorityTopicsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/hooks/use-toast";
import { Plus, Search, Library, Trash2, CheckCircle, Circle, TrendingUp, Lock, Upload, ChevronDown, ChevronUp, FlaskConical, BookOpen } from "lucide-react";

const topicSchema = z.object({
  name: z.string().min(1, "Name is required"),
  subject: z.string().min(1, "Subject is required"),
  difficultyLevel: z.coerce.number().min(1).max(5),
  estimatedHours: z.coerce.number().min(0.5).max(1000),
  masteryScore: z.coerce.number().min(0).max(1).optional(),
  prerequisites: z.string().optional(),
});

const SUBJECTS = ["Mathematics", "Physics", "Chemistry", "Biology", "History", "Economics", "English", "Computer Science", "Other"];
const TARGET_MASTERY_THRESHOLD = 0.8;

function CurriculumForecast({ topics, summary }: {
  topics: Array<{ estimatedHours: number; masteryScore: number; isCompleted: boolean }>;
  summary: { averageMastery: number; daysUntilExam: number; weeklyStudiedHours: number; examDate: string };
}) {
  if (topics.length === 0) return null;
  const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const totalEstimatedHours = topics.reduce((s, t) => s + t.estimatedHours, 0);
  const completedTopics = topics.filter((t) => t.isCompleted).length;
  const avgMastery = clamp01(summary.averageMastery);
  const daysLeft = summary.daysUntilExam;
  const weeklyHours = summary.weeklyStudiedHours;
  const dailyHours = weeklyHours > 0 ? weeklyHours / 7 : 0;
  const hoursRemaining = daysLeft * dailyHours;
  const masteryGainPerHour = totalEstimatedHours > 0 ? 0.7 / totalEstimatedHours : 0;
  const projectedMastery = clamp01(avgMastery + hoursRemaining * masteryGainPerHour);
  const projectedPercent = Math.round(projectedMastery * 100);
  const currentPercent = Math.round(avgMastery * 100);
  const onTrack = projectedMastery >= TARGET_MASTERY_THRESHOLD;
  const masteryGap = Math.max(TARGET_MASTERY_THRESHOLD - avgMastery, 0);
  const recommendedDailyHours = totalEstimatedHours > 0 && daysLeft > 0
    ? (totalEstimatedHours * masteryGap) / daysLeft
    : 0;
  const additionalDailyHours = Math.max(0, recommendedDailyHours - dailyHours);
  const examDateStr = new Date(summary.examDate).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  let verdict: string;
  let action: string;
  if (weeklyHours === 0) {
    verdict = "No study hours recorded yet, so your forecast is still blank.";
    action = "Log your first session today to get a real pace target.";
  } else if (onTrack) {
    verdict = `At your current pace, you are on track to finish strong by ${examDateStr}.`;
    action = "Keep this pace and protect your daily consistency.";
  } else {
    verdict = "At your current pace, you may not complete the syllabus.";
    const roundedGap = Math.round(additionalDailyHours * 10) / 10;
    const recommendedGap = Math.max(roundedGap, 0);
    action = `You need about +${recommendedGap.toFixed(1)} hours/day to stay on track.`;
  }
  return (
    <Card className={onTrack ? "border-emerald-200 bg-emerald-50/50" : "border-amber-200 bg-amber-50/40"}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" />Curriculum Forecast</CardTitle>
          <span className="text-xs text-muted-foreground">{completedTopics}/{topics.length} topics complete</span>
        </div>
        <CardDescription className="text-xs">{verdict}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm font-medium">{action}</div>
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground"><span>Current mastery</span><span>{currentPercent}%</span></div>
          <Progress value={currentPercent} className="h-2" />
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Projected by {examDateStr}</span>
            <span className={projectedPercent >= 80 ? "text-emerald-700 font-medium" : projectedPercent >= 60 ? "text-amber-700 font-medium" : "text-red-700 font-medium"}>
              {weeklyHours > 0 ? `~${projectedPercent}%` : "—"}
            </span>
          </div>
          {weeklyHours > 0 && (
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div className={`h-full rounded-full transition-all duration-700 ${projectedPercent >= 80 ? "bg-emerald-500" : projectedPercent >= 60 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${projectedPercent}%` }} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function BlockedByInfo({ topic, allTopics }: { topic: { prerequisites: number[]; name: string }; allTopics: Array<{ id: number; name: string; masteryScore: number; isCompleted: boolean }> }) {
  const blocking = topic.prerequisites.map((id) => allTopics.find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => !!t && !t.isCompleted && t.masteryScore < 0.6);
  if (blocking.length === 0) return null;
  return (
    <div className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2 mt-2">
      <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      <span><span className="font-medium">Blocked by: </span>{blocking.map((t, i) => <span key={t.id}>{t.name} ({Math.round(t.masteryScore * 100)}% — needs 60%){i < blocking.length - 1 ? ", " : ""}</span>)}</span>
    </div>
  );
}

function TopicHistory({ topicId }: { topicId: number }) {
  const { data: sessions, isLoading } = useQuery<Array<{ id: number; sessionType: string; durationMinutes: number; testScore: number | null; testScoreMax: number | null; studiedAt: string }>>({
    queryKey: ["sessions", "topic", topicId],
    queryFn: () => fetch(`/api/sessions?topicId=${topicId}&limit=10`).then((r) => r.json()),
  });

  if (isLoading) return <div className="text-xs text-muted-foreground py-2">Loading history…</div>;
  if (!sessions || sessions.length === 0) return <div className="text-xs text-muted-foreground py-2">No sessions logged for this topic yet.</div>;

  return (
    <div className="border-t mt-3 pt-3 space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground mb-2">Session history</p>
      {sessions.map((s) => (
        <div key={s.id} className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5">
            {s.sessionType === "practice" ? <FlaskConical className="h-3 w-3 text-primary" /> : <BookOpen className="h-3 w-3 text-muted-foreground" />}
            <span>{new Date(s.studiedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
            <Badge variant={s.sessionType === "practice" ? "default" : "secondary"} className="text-[10px] py-0 px-1.5">{s.sessionType}</Badge>
          </div>
          <div className="flex items-center gap-3 text-muted-foreground">
            {s.testScore !== null && s.testScoreMax !== null && (
              <span className="font-medium text-foreground">{Math.round((s.testScore / s.testScoreMax) * 100)}%</span>
            )}
            <span>{s.durationMinutes}m</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function parseCSV(text: string): {
  rows: Array<{ name: string; subject: string; difficultyLevel: number; estimatedHours: number; masteryScore: number }>;
  warnings: string[];
  rejectedRows: number;
} {
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const results: Array<{ name: string; subject: string; difficultyLevel: number; estimatedHours: number; masteryScore: number }> = [];
  const warnings: string[] = [];
  let rejectedRows = 0;
  const startIndex = lines[0]?.toLowerCase().includes("name") ? 1 : 0;
  for (const [index, line] of lines.slice(startIndex).entries()) {
    const rowNumber = startIndex + index + 1;
    const cols = line.split(",").map((c) => c.trim().replace(/^["']|["']$/g, ""));
    if (cols.length < 2) {
      warnings.push(`Row ${rowNumber}: rejected (missing required name/subject columns).`);
      rejectedRows++;
      continue;
    }
    const name = cols[0];
    const subject = cols[1] || "Other";
    const difficultyLevel = Math.min(5, Math.max(1, parseInt(cols[2]) || 3));
    const estimatedHours = Math.max(0.5, parseFloat(cols[3]) || 5);
    const masteryRaw = cols[4];
    let masteryScore = 0;

    if (masteryRaw === undefined || masteryRaw === "") {
      warnings.push(`Row ${rowNumber}: mastery missing; defaulted to 0.0.`);
    } else {
      const parsedMastery = parseFloat(masteryRaw);
      if (!Number.isFinite(parsedMastery) || parsedMastery < 0 || parsedMastery > 1) {
        warnings.push(`Row ${rowNumber}: rejected out-of-range mastery "${masteryRaw}" (must be 0..1).`);
        rejectedRows++;
        continue;
      }
      masteryScore = parsedMastery;
    }

    if (name) {
      results.push({ name, subject, difficultyLevel, estimatedHours, masteryScore });
    } else {
      warnings.push(`Row ${rowNumber}: rejected empty topic name.`);
      rejectedRows++;
    }
  }
  return { rows: results, warnings, rejectedRows };
}

export default function Topics() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<number | null>(null);
  const [showAllTopics, setShowAllTopics] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: topics, isLoading } = useListTopics();
  const { data: summary } = useGetDashboardSummary();
  const createTopic = useCreateTopic();
  const updateTopic = useUpdateTopic();
  const deleteTopic = useDeleteTopic();

  const form = useForm<z.infer<typeof topicSchema>>({
    resolver: zodResolver(topicSchema),
    defaultValues: { name: "", subject: "", difficultyLevel: 3, estimatedHours: 10, masteryScore: 0, prerequisites: "" },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListTopicsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPriorityTopicsQueryKey() });
  };

  function onSubmit(data: z.infer<typeof topicSchema>) {
    const prereqs = data.prerequisites ? data.prerequisites.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n)) : [];
    createTopic.mutate(
      { data: { name: data.name, subject: data.subject, difficultyLevel: data.difficultyLevel, estimatedHours: data.estimatedHours, masteryScore: data.masteryScore ?? 0, prerequisites: prereqs } },
      {
        onSuccess: () => { toast({ title: "Topic added", description: `${data.name} is now in your curriculum.` }); setAddOpen(false); form.reset(); invalidate(); },
        onError: () => toast({ title: "Error", description: "Could not create topic.", variant: "destructive" }),
      }
    );
  }

  function toggleComplete(topicId: number, isCompleted: boolean) {
    updateTopic.mutate({ id: topicId, data: { isCompleted: !isCompleted } }, { onSuccess: () => invalidate() });
  }

  function confirmDelete() {
    if (!deleteId) return;
    deleteTopic.mutate({ id: deleteId }, {
      onSuccess: () => { toast({ title: "Topic deleted" }); setDeleteId(null); invalidate(); },
      onError: () => toast({ title: "Error", description: "Could not delete topic.", variant: "destructive" }),
    });
  }

  async function handleCSVImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const text = await file.text();
    const parsed = parseCSV(text);
    const { rows, warnings, rejectedRows } = parsed;
    if (warnings.length > 0) {
      for (const warning of warnings) {
        console.warn(`[CSV import] ${warning}`);
      }
    }
    if (rows.length === 0) { toast({ title: "No valid rows found", description: "Check your CSV format: name,subject,difficulty,estimatedHours,mastery", variant: "destructive" }); return; }
    setImporting(true);
    let created = 0; let failed = 0;
    for (const row of rows) {
      try {
        await new Promise<void>((resolve) => {
          createTopic.mutate(
            { data: { name: row.name, subject: row.subject, difficultyLevel: row.difficultyLevel, estimatedHours: row.estimatedHours, masteryScore: row.masteryScore, prerequisites: [] } },
            { onSuccess: () => { created++; resolve(); }, onError: () => { failed++; resolve(); } }
          );
        });
      } catch { failed++; }
    }
    setImporting(false);
    invalidate();
    const failureCount = failed + rejectedRows;
    const warningCount = warnings.length;
    toast({
      title: `Import complete — ${created} topics added`,
      description: failureCount > 0
        ? `${failureCount} rows failed/rejected.${warningCount > 0 ? ` ${warningCount} warnings logged.` : ""}`
        : warningCount > 0
          ? `${warningCount} warnings logged.`
          : "All rows imported successfully.",
    });
  }

  const allTopics = topics ?? [];
  const filtered = allTopics.filter((t) =>
    t.name.toLowerCase().includes(search.toLowerCase()) || t.subject.toLowerCase().includes(search.toLowerCase())
  );
  const activeTopics = allTopics.filter((t) => !t.isCompleted);
  const focusNow = [...activeTopics]
    .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
    .slice(0, 5);
  const weakAreas = [...activeTopics]
    .sort((a, b) => a.masteryScore - b.masteryScore)
    .slice(0, 5);
  const recentlyStudied = [...activeTopics]
    .filter((t) => Boolean(t.lastStudiedAt))
    .sort((a, b) => new Date(b.lastStudiedAt ?? 0).getTime() - new Date(a.lastStudiedAt ?? 0).getTime())
    .slice(0, 5);

  return (
    <div className="space-y-6" data-testid="topics-page">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Topics</h1>
          <p className="text-muted-foreground">{allTopics.length} topics in your curriculum</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleCSVImport} />
          <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={importing} size="sm" className="min-h-[40px]">
            <Upload className="h-4 w-4 mr-2" />{importing ? "Importing..." : "Import CSV"}
          </Button>
          <Button onClick={() => setAddOpen(true)} className="min-h-[40px]" data-testid="button-add-topic">
            <Plus className="h-4 w-4 mr-2" />Add Topic
          </Button>
        </div>
      </div>

      {allTopics.length > 0 && summary && <CurriculumForecast topics={allTopics} summary={summary} />}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Focus Now</CardTitle>
            <CardDescription>Start with these highest-impact topics.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {focusNow.length > 0 ? focusNow.map((topic) => (
              <div key={`focus-${topic.id}`} className="rounded-md border px-2.5 py-2">
                <p className="text-sm font-medium line-clamp-1">{topic.name}</p>
                <p className="text-xs text-muted-foreground">{topic.subject} · {Math.round(topic.masteryScore * 100)}% mastery</p>
              </div>
            )) : <p className="text-xs text-muted-foreground">Add topics to generate focus picks.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Weak Areas</CardTitle>
            <CardDescription>Patch these to reduce exam risk fastest.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {weakAreas.length > 0 ? weakAreas.map((topic) => (
              <div key={`weak-${topic.id}`} className="rounded-md border px-2.5 py-2">
                <p className="text-sm font-medium line-clamp-1">{topic.name}</p>
                <p className="text-xs text-muted-foreground">{Math.round(topic.masteryScore * 100)}% mastery · {topic.estimatedHours}h est.</p>
              </div>
            )) : <p className="text-xs text-muted-foreground">No weak areas yet.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Recently Studied</CardTitle>
            <CardDescription>Quick restart options from recent momentum.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {recentlyStudied.length > 0 ? recentlyStudied.map((topic) => (
              <div key={`recent-${topic.id}`} className="rounded-md border px-2.5 py-2">
                <p className="text-sm font-medium line-clamp-1">{topic.name}</p>
                <p className="text-xs text-muted-foreground">
                  Last: {new Date(topic.lastStudiedAt ?? "").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </p>
              </div>
            )) : <p className="text-xs text-muted-foreground">No sessions logged recently.</p>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm">All Topics</CardTitle>
              <CardDescription>Use search when you need the full curriculum list.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowAllTopics((v) => !v)}>
              {showAllTopics ? <ChevronUp className="h-4 w-4 mr-1" /> : <ChevronDown className="h-4 w-4 mr-1" />}
              {showAllTopics ? "Hide list" : "Browse list"}
            </Button>
          </div>
        </CardHeader>
        {showAllTopics && (
          <CardContent className="pt-0">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search topics..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="input-search" />
            </div>
          </CardContent>
        )}
      </Card>

      {allTopics.length > 0 && allTopics.length < 3 && (
        <div className="text-xs text-muted-foreground bg-muted/40 rounded-md px-3 py-2 border">
          <span className="font-medium">Tip:</span> Add at least 3 topics so the scheduler can build a meaningful dependency graph.{" "}
          <button className="underline" onClick={() => fileInputRef.current?.click()}>Import a CSV</button> to add many at once.
        </div>
      )}

      {showAllTopics ? (
        isLoading ? (
          <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
        ) : filtered.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
              <Library className="h-10 w-10 mb-3 opacity-40" />
              {allTopics.length === 0 ? (
                <>
                  <p className="font-medium">No topics yet</p>
                  <p className="text-sm mt-1">Add your first topic or import a CSV to build your curriculum.</p>
                  <div className="flex gap-2 mt-4">
                    <Button onClick={() => setAddOpen(true)}>Add topic</Button>
                    <Button variant="outline" onClick={() => fileInputRef.current?.click()}>Import CSV</Button>
                  </div>
                </>
              ) : <p className="font-medium">No topics match your search</p>}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {filtered.map((topic) => {
              const isBlocked = topic.prerequisites.some((pid) => {
                const p = allTopics.find((t) => t.id === pid);
                return p && !p.isCompleted && p.masteryScore < 0.6;
              });
              const hasConfidence = topic.testsCount > 0;
              const isHistoryOpen = expandedHistory === topic.id;

              return (
                <Card key={topic.id} className={`transition-all hover:shadow-sm ${topic.isCompleted ? "opacity-60" : ""}`} data-testid={`topic-${topic.id}`}>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-start gap-3">
                      <button onClick={() => toggleComplete(topic.id, topic.isCompleted)} className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary transition-colors min-h-[32px] min-w-[32px] flex items-center justify-center" data-testid={`toggle-complete-${topic.id}`}>
                        {topic.isCompleted ? <CheckCircle className="h-5 w-5 text-primary" /> : <Circle className="h-5 w-5" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <button className="font-semibold text-left hover:underline text-sm" onClick={() => setExpandedHistory(isHistoryOpen ? null : topic.id)}>
                            <span className={topic.isCompleted ? "line-through" : ""}>{topic.name}</span>
                          </button>
                          <Badge variant="outline" className="text-xs">{topic.subject}</Badge>
                          <Badge variant="secondary" className="text-xs">{"★".repeat(topic.difficultyLevel)}{"☆".repeat(5 - topic.difficultyLevel)}</Badge>
                          {isBlocked && !topic.isCompleted && (
                            <Badge variant="outline" className="text-xs text-amber-700 border-amber-300 bg-amber-50">
                              <Lock className="h-2.5 w-2.5 mr-1" />blocked
                            </Badge>
                          )}
                          {topic.prerequisites.length > 0 && !isBlocked && (
                            <Badge variant="outline" className="text-xs text-muted-foreground">{topic.prerequisites.length} prereq{topic.prerequisites.length > 1 ? "s" : ""}</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground mb-2 flex-wrap">
                          <span>{topic.estimatedHours}h estimated</span>
                          <span>Mastery: {Math.round(topic.masteryScore * 100)}%</span>
                          {hasConfidence && (
                            <span className={`font-medium ${topic.confidenceScore >= 0.5 ? "text-emerald-700" : topic.confidenceScore >= 0.2 ? "text-amber-700" : "text-muted-foreground"}`}>
                              Confidence: {Math.round(topic.confidenceScore * 100)}% ({topic.testsCount} test{topic.testsCount !== 1 ? "s" : ""})
                            </span>
                          )}
                          {!hasConfidence && <span className="italic text-muted-foreground/70">no practice yet</span>}
                          {topic.lastStudiedAt && (
                            <span>Last: {new Date(topic.lastStudiedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                          )}
                        </div>
                        <Progress value={topic.masteryScore * 100} className="h-1.5" />
                        <BlockedByInfo topic={topic} allTopics={allTopics} />
                        {isHistoryOpen && <TopicHistory topicId={topic.id} />}
                      </div>
                      <div className="flex items-center gap-1 shrink-0 mt-0.5">
                        <button onClick={() => setExpandedHistory(isHistoryOpen ? null : topic.id)} className="text-muted-foreground hover:text-foreground transition-colors min-h-[32px] min-w-[32px] flex items-center justify-center" title={isHistoryOpen ? "Hide history" : "Show history"}>
                          {isHistoryOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </button>
                        <button onClick={() => setDeleteId(topic.id)} className="text-muted-foreground hover:text-destructive transition-colors min-h-[32px] min-w-[32px] flex items-center justify-center" data-testid={`delete-topic-${topic.id}`}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Focus sections are shown above. Open <span className="font-medium">Browse list</span> when you need every topic.
          </CardContent>
        </Card>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Topic</DialogTitle>
            <DialogDescription>Add a topic to your curriculum. The scheduler will prioritize it using the dependency graph.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Topic Name</FormLabel><FormControl><Input placeholder="e.g. Differential Equations" data-testid="input-topic-name" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="subject" render={({ field }) => (
                <FormItem>
                  <FormLabel>Subject</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger data-testid="select-subject"><SelectValue placeholder="Select subject" /></SelectTrigger></FormControl>
                    <SelectContent>{SUBJECTS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="difficultyLevel" render={({ field }) => (
                  <FormItem><FormLabel>Difficulty (1–5)</FormLabel><FormControl><Input type="number" min="1" max="5" data-testid="input-difficulty" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="estimatedHours" render={({ field }) => (
                  <FormItem><FormLabel>Estimated Hours</FormLabel><FormControl><Input type="number" min="0.5" step="0.5" data-testid="input-estimated-hours" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="masteryScore" render={({ field }) => (
                <FormItem>
                  <FormLabel>Initial Mastery (0–1)</FormLabel>
                  <FormControl><Input type="number" min="0" max="1" step="0.05" placeholder="0.0" data-testid="input-mastery" {...field} /></FormControl>
                  <FormDescription>0 = no knowledge, 1 = complete mastery</FormDescription>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="prerequisites" render={({ field }) => (
                <FormItem>
                  <FormLabel>Prerequisites (Topic IDs, comma-separated)</FormLabel>
                  <FormControl><Input placeholder="e.g. 1, 3" data-testid="input-prerequisites" {...field} /></FormControl>
                  <FormDescription>The scheduler won't assign this until prerequisites reach 60% mastery.</FormDescription>
                  <FormMessage />
                </FormItem>
              )} />
              <Button type="submit" className="w-full" disabled={createTopic.isPending} data-testid="button-submit-topic">
                {createTopic.isPending ? "Adding..." : "Add Topic"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteId !== null} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete topic?</AlertDialogTitle>
            <AlertDialogDescription>This will remove the topic and all its scheduling data. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
