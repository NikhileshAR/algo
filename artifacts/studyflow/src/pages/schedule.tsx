import { useRef, useState, useEffect, useMemo } from "react";
import {
  useGetTodaySchedule,
  useRecalculateSchedule,
  useLogSession,
  useListSessions,
  useListTopics,
  getGetTodayScheduleQueryKey,
  getListSessionsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetPriorityTopicsQueryKey,
  getListTopicsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, Clock, CheckCircle2, BookOpen, Target, Info, Play, Square } from "lucide-react";
import { recordManualTelemetryEvent, syncSchedulerTelemetryInput } from "@/lib/local-db/bridge";
import { runFeedbackLoop } from "@/lib/feedback-loop";

const logSessionSchema = z.object({
  topicId: z.coerce.number().min(1, "Select a topic"),
  sessionType: z.enum(["lecture", "practice"]),
  durationMinutes: z.coerce.number().min(1).max(480),
  testScore: z.coerce.number().min(0).max(100).optional(),
  testScoreMax: z.coerce.number().min(1).optional(),
  notes: z.string().optional(),
});

interface ActiveTimer {
  blockIndex: number;
  topicId: number;
  topicName: string;
  sessionType: "lecture" | "practice";
  startedAt: number;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isIsoDayMatch(studiedAt: unknown, day: string): boolean {
  return typeof studiedAt === "string" && studiedAt.startsWith(day);
}

const STUDY_DAY_START_HOUR = 6;
const STUDY_DAY_DURATION_HOURS = 16;
const ON_TRACK_GRACE_MINUTES = 10;
const MOMENTUM_THRESHOLD_SECONDS = 10 * 60;

function getMomentumLabel(active: boolean, elapsedSeconds: number, completionPct: number, completedMinutes: number): string {
  if (active && elapsedSeconds >= MOMENTUM_THRESHOLD_SECONDS) return "Building momentum";
  if (completionPct >= 100) return "Mission complete";
  if (completedMinutes > 0) return "In motion";
  return "Ready to start";
}

function getSessionHint(
  mastery: number,
  sessionType: "lecture" | "practice",
  daysSinceStudied: number | null,
): string {
  const parts: string[] = [];

  if (daysSinceStudied !== null && daysSinceStudied >= 14) {
    parts.push(`Last studied ${daysSinceStudied} days ago — start with a 5-minute recap.`);
  } else if (daysSinceStudied !== null && daysSinceStudied >= 7) {
    parts.push(`You haven't reviewed this in ${daysSinceStudied} days — warm up before diving in.`);
  }

  if (sessionType === "practice") {
    if (mastery < 0.4) {
      parts.push("Mastery is low — try worked examples before unseen problems.");
    } else if (mastery < 0.7) {
      parts.push("Run timed problems and review every mistake carefully.");
    } else {
      parts.push("Strong mastery — push for speed and tackle the hardest variants.");
    }
  } else {
    if (mastery < 0.3) {
      parts.push("Foundation phase — go slow, build mental models, take structured notes.");
    } else if (mastery < 0.6) {
      parts.push("Consolidation phase — connect concepts, look for gaps in understanding.");
    } else {
      parts.push("Advanced review — focus on edge cases and things you're least confident about.");
    }
  }

  return parts.join(" ");
}

export default function Schedule() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [logOpen, setLogOpen] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState<{
    topicId: number;
    topicName: string;
    durationMinutes: number;
    sessionType: "lecture" | "practice";
  } | null>(null);

  const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: schedule, isLoading } = useGetTodaySchedule();
  const { data: topics } = useListTopics();
  const { data: sessions } = useListSessions({ limit: 200 });
  const recalculate = useRecalculateSchedule();
  const logSession = useLogSession();

  const form = useForm<z.infer<typeof logSessionSchema>>({
    resolver: zodResolver(logSessionSchema),
    defaultValues: { sessionType: "lecture", durationMinutes: 60 },
  });

  const sessionType = form.watch("sessionType");

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const topicMap = new Map((topics ?? []).map((t) => [t.id, t]));

  function getDaysSinceStudied(topicId: number): number | null {
    const topic = topicMap.get(topicId);
    if (!topic?.lastStudiedAt) return null;
    const diff = Date.now() - new Date(topic.lastStudiedAt).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  function startTimer(block: { topicId: number; topicName: string; sessionType: "lecture" | "practice" }, idx: number) {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setElapsed(0);
    setActiveTimer({ blockIndex: idx, topicId: block.topicId, topicName: block.topicName, sessionType: block.sessionType, startedAt: Date.now() });
    intervalRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  }

  function stopTimer(block: { topicId: number; topicName: string; durationMinutes: number; sessionType: "lecture" | "practice" }) {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    const actualMinutes = Math.max(1, Math.ceil(elapsed / 60));
    setActiveTimer(null);
    setElapsed(0);
    openLog({ ...block, durationMinutes: actualMinutes });
  }

  function openLog(block?: { topicId: number; topicName: string; durationMinutes: number; sessionType: "lecture" | "practice" }) {
    if (block) {
      setSelectedBlock(block);
      form.reset({ topicId: block.topicId, sessionType: block.sessionType, durationMinutes: block.durationMinutes });
    } else {
      setSelectedBlock(null);
      form.reset({ sessionType: "lecture", durationMinutes: 60 });
    }
    setLogOpen(true);
  }

  function handleRecalculate() {
    const today = new Date().toISOString().split("T")[0];
    void syncSchedulerTelemetryInput(today).finally(() => {
      recalculate.mutate(undefined, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({ title: "Schedule recalculated", description: "Your plan has been updated based on your telemetry + current state." });
        },
      });
    });
  }

  function onSubmit(data: z.infer<typeof logSessionSchema>) {
    const topic = topicMap.get(data.topicId);
    const topicName = selectedBlock?.topicName ?? topic?.name ?? "topic";
    const masteryBefore = topic?.masteryScore;

    logSession.mutate(
      { data: { topicId: data.topicId, sessionType: data.sessionType, durationMinutes: data.durationMinutes, testScore: data.testScore, testScoreMax: data.testScoreMax, notes: data.notes } },
      {
        onSuccess: () => {
          let description = masteryBefore !== undefined
            ? `Mastery was ${Math.round(masteryBefore * 100)}% — the algorithm is updating it now.`
            : "Mastery and capacity scores updated.";

          if (
            data.sessionType === "practice" &&
            data.testScore !== undefined &&
            data.testScoreMax !== undefined &&
            masteryBefore !== undefined &&
            topic
          ) {
            const nt = topic.testsCount + 1;
            const alpha = 1 / nt;
            const normalized = data.testScore / Math.max(data.testScoreMax, 1);
            const newMastery = Math.min(1, Math.max(0, masteryBefore + alpha * (normalized - masteryBefore)));
            description = `Mastery: ${Math.round(masteryBefore * 100)}% → ${Math.round(newMastery * 100)}%`;
          }

          toast({ title: `Session logged · ${topicName}`, description });
          setLogOpen(false);
          form.reset();
          queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetPriorityTopicsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListTopicsQueryKey() });
          if (topicName) {
            void recordManualTelemetryEvent({
              topic: topicName,
              durationMinutes: data.durationMinutes,
              title: data.notes || undefined,
            });
            // Phase 4: update local mastery state via feedback loop
            void runFeedbackLoop({
              topicId: String(data.topicId),
              topicName,
              serverMastery: topic?.masteryScore ?? 0.1,
              focusedMinutes: data.durationMinutes,
            });
          }
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to log session.", variant: "destructive" });
        },
      }
    );
  }

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const todayIso = new Date().toISOString().split("T")[0];
  const scheduleBlocks = Array.isArray(schedule?.blocks) ? schedule.blocks : [];
  const scheduleHours = typeof schedule?.scheduledHours === "number" ? schedule.scheduledHours : 0;
  const hasSchedule = Boolean(schedule);
  const missionTotalMinutes = Math.max(0, Math.round(scheduleHours * 60));
  const loggedMinutesToday = useMemo(
    () => (sessions ?? [])
      .filter((s) => isIsoDayMatch(s.studiedAt, todayIso))
      .reduce((sum, s) => sum + s.durationMinutes, 0),
    [sessions, todayIso],
  );
  const missionCompletedMinutes = Math.max(0, loggedMinutesToday + (activeTimer ? elapsed / 60 : 0));
  const missionCompletion = missionTotalMinutes > 0
    ? Math.min(100, Math.round((missionCompletedMinutes / missionTotalMinutes) * 100))
    : 0;
  const missionRemainingMinutes = Math.max(0, Math.round(missionTotalMinutes - missionCompletedMinutes));
  const now = new Date();
  const dayMinutes = now.getHours() * 60 + now.getMinutes();
  const dayProgress = clamp(
    (dayMinutes - STUDY_DAY_START_HOUR * 60) / (STUDY_DAY_DURATION_HOURS * 60),
    0,
    1,
  );
  const expectedByNow = missionTotalMinutes * dayProgress;
  const onTrack = missionCompletedMinutes + ON_TRACK_GRACE_MINUTES >= expectedByNow;
  const momentumLabel = getMomentumLabel(Boolean(activeTimer), elapsed, missionCompletion, missionCompletedMinutes);

  return (
    <div className="space-y-6" data-testid="schedule-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Today's Schedule</h1>
          <p className="text-muted-foreground">{today}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => openLog()} data-testid="button-log-session">
            <CheckCircle2 className="h-4 w-4 mr-2" />
            Log Session
          </Button>
          <Button variant="outline" size="sm" onClick={handleRecalculate} disabled={recalculate.isPending} data-testid="button-recalculate">
            <RefreshCw className={`h-4 w-4 mr-2 ${recalculate.isPending ? "animate-spin" : ""}`} />
            Recalculate
          </Button>
        </div>
      </div>

      {activeTimer && (
        <div className="rounded-lg border-2 border-primary bg-primary/5 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
            <div>
              <p className="text-sm font-semibold">Studying: {activeTimer.topicName}</p>
              <p className="text-xs text-muted-foreground">{activeTimer.sessionType} session in progress</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-xl font-bold text-primary tabular-nums">{formatElapsed(elapsed)}</span>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : hasSchedule ? (
        <>
          <Card className="border-primary/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Today’s Mission</CardTitle>
              <CardDescription>
                Target {scheduleHours.toFixed(1)}h · {missionRemainingMinutes}m left ·{" "}
                <span className={onTrack ? "text-emerald-700 font-medium" : "text-amber-700 font-medium"}>
                  {onTrack ? "On track ✓" : "Behind pace ⚠"}
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Progress value={missionCompletion} className="h-2" />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{missionCompletion}% complete</span>
                <span>{momentumLabel}</span>
              </div>
            </CardContent>
          </Card>

          {schedule?.isReset && (
            <div className="rounded-lg border bg-accent/50 px-4 py-3 text-sm text-accent-foreground">
              Fresh recovery mission prepared with a lighter target. Focus only on today’s sequence.
            </div>
          )}

          <div className="space-y-3">
            {scheduleBlocks.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                  <BookOpen className="h-10 w-10 mb-3 opacity-40" />
                  <p className="font-medium">No study blocks scheduled</p>
                  <p className="text-sm mt-1">Add topics first, then recalculate the schedule.</p>
                </CardContent>
              </Card>
            ) : (
              scheduleBlocks.map((block, i) => {
                const daysSince = getDaysSinceStudied(block.topicId);
                const hint = getSessionHint(block.masteryScore, block.sessionType, daysSince);
                const isThisActive = activeTimer?.blockIndex === i;
                const hasOtherActive = activeTimer !== null && !isThisActive;

                return (
                  <Card key={i} className={`transition-all hover:shadow-md ${isThisActive ? "ring-2 ring-primary" : ""}`} data-testid={`block-${i}`}>
                    <CardContent className="pt-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <h3 className="font-semibold">{block.topicName}</h3>
                            <Badge variant="outline" className="text-xs">{block.subject}</Badge>
                            <Badge variant={block.sessionType === "practice" ? "default" : "secondary"} className="text-xs">{block.sessionType}</Badge>
                          </div>
                          <div className="space-y-2">
                            <div className="flex items-center gap-4 text-sm text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {isThisActive ? `${formatElapsed(elapsed)} elapsed` : `${block.durationMinutes}m`}
                              </span>
                              <span>Mastery: {Math.round(block.masteryScore * 100)}%</span>
                              {daysSince !== null && daysSince > 0 && (
                                <span className="text-xs">Last studied {daysSince}d ago</span>
                              )}
                            </div>
                            <Progress value={block.masteryScore * 100} className="h-1.5" />
                            <div className="flex items-start gap-1.5 text-xs text-muted-foreground bg-muted/40 rounded-md px-2.5 py-2">
                              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                              <span className="italic">{hint}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col gap-2 shrink-0">
                          {isThisActive ? (
                            <Button
                              className="min-h-[44px] bg-primary text-primary-foreground px-3 text-sm"
                              onClick={() => stopTimer({ topicId: block.topicId, topicName: block.topicName, durationMinutes: block.durationMinutes, sessionType: block.sessionType })}
                              data-testid={`button-stop-${i}`}
                            >
                              <Square className="h-3.5 w-3.5 mr-1 fill-current" />
                              Stop & Log
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              className="min-h-[44px] px-3 text-sm"
                              onClick={() => startTimer({ topicId: block.topicId, topicName: block.topicName, sessionType: block.sessionType }, i)}
                              disabled={hasOtherActive}
                              data-testid={`button-start-${i}`}
                            >
                              <Play className="h-3.5 w-3.5 mr-1 fill-current" />
                              Start
                            </Button>
                          )}
                          {!isThisActive && (
                            <Button
                              variant="ghost"
                              className="min-h-[44px] px-3 text-xs text-muted-foreground"
                              onClick={() => openLog({ topicId: block.topicId, topicName: block.topicName, durationMinutes: block.durationMinutes, sessionType: block.sessionType })}
                              data-testid={`button-log-block-${i}`}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                              Log manually
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </>
      ) : null}

      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selectedBlock ? `Log: ${selectedBlock.topicName}` : "Log Study Session"}</DialogTitle>
            <DialogDescription>
              Recording your session updates mastery scores and recalibrates your schedule.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="topicId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Topic</FormLabel>
                    <Select onValueChange={(v) => field.onChange(Number(v))} value={field.value ? String(field.value) : ""}>
                      <FormControl>
                        <SelectTrigger data-testid="select-topic"><SelectValue placeholder="Select topic" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {topics?.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name} — {t.subject}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="sessionType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Session Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-session-type"><SelectValue /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="lecture">Lecture</SelectItem>
                          <SelectItem value="practice">Practice</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="durationMinutes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Duration (minutes)</FormLabel>
                      <FormControl>
                        <Input type="number" min="1" max="480" data-testid="input-duration" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              {sessionType === "practice" && (
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="testScore"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Test Score</FormLabel>
                        <FormControl><Input type="number" min="0" max="100" placeholder="72" data-testid="input-test-score" {...field} /></FormControl>
                        <FormDescription>Your raw score</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="testScoreMax"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Max Score</FormLabel>
                        <FormControl><Input type="number" min="1" placeholder="100" data-testid="input-test-score-max" {...field} /></FormControl>
                        <FormDescription>Total possible</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              )}
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes (optional)</FormLabel>
                    <FormControl><Textarea placeholder="What did you cover? Any blockers?" data-testid="textarea-notes" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" className="w-full" disabled={logSession.isPending} data-testid="button-submit-session">
                {logSession.isPending ? "Logging..." : "Log Session"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
