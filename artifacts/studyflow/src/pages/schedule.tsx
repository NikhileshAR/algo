import { useState } from "react";
import {
  useGetTodaySchedule,
  useRecalculateSchedule,
  useLogSession,
  useListTopics,
  getGetTodayScheduleQueryKey,
  getListSessionsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetPriorityTopicsQueryKey,
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
import { RefreshCw, Clock, CheckCircle2, BookOpen, Target } from "lucide-react";

const logSessionSchema = z.object({
  topicId: z.coerce.number().min(1, "Select a topic"),
  sessionType: z.enum(["lecture", "practice"]),
  durationMinutes: z.coerce.number().min(1).max(480),
  testScore: z.coerce.number().min(0).max(100).optional(),
  testScoreMax: z.coerce.number().min(1).optional(),
  notes: z.string().optional(),
});

export default function Schedule() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [logOpen, setLogOpen] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState<{ topicId: number; topicName: string; durationMinutes: number; sessionType: "lecture" | "practice" } | null>(null);

  const { data: schedule, isLoading } = useGetTodaySchedule();
  const { data: topics } = useListTopics();
  const recalculate = useRecalculateSchedule();
  const logSession = useLogSession();

  const form = useForm<z.infer<typeof logSessionSchema>>({
    resolver: zodResolver(logSessionSchema),
    defaultValues: {
      sessionType: "lecture",
      durationMinutes: 60,
    },
  });

  const sessionType = form.watch("sessionType");

  function openLog(block?: { topicId: number; topicName: string; durationMinutes: number; sessionType: "lecture" | "practice" }) {
    if (block) {
      setSelectedBlock(block);
      form.reset({
        topicId: block.topicId,
        sessionType: block.sessionType,
        durationMinutes: block.durationMinutes,
      });
    } else {
      setSelectedBlock(null);
      form.reset({ sessionType: "lecture", durationMinutes: 60 });
    }
    setLogOpen(true);
  }

  function handleRecalculate() {
    recalculate.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        toast({ title: "Schedule recalculated", description: "Your plan has been updated based on your current state." });
      },
    });
  }

  function onSubmit(data: z.infer<typeof logSessionSchema>) {
    logSession.mutate(
      {
        data: {
          topicId: data.topicId,
          sessionType: data.sessionType,
          durationMinutes: data.durationMinutes,
          testScore: data.testScore,
          testScoreMax: data.testScoreMax,
          notes: data.notes,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Session logged", description: "Mastery and capacity updated." });
          setLogOpen(false);
          form.reset();
          queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetPriorityTopicsQueryKey() });
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to log session.", variant: "destructive" });
        },
      }
    );
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

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
          <Button
            variant="outline"
            size="sm"
            onClick={handleRecalculate}
            disabled={recalculate.isPending}
            data-testid="button-recalculate"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${recalculate.isPending ? "animate-spin" : ""}`} />
            Recalculate
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : schedule ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                  <Clock className="h-4 w-4" />
                  Scheduled today
                </div>
                <p className="text-2xl font-bold">{schedule.scheduledHours.toFixed(1)}h</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                  <BookOpen className="h-4 w-4" />
                  Study blocks
                </div>
                <p className="text-2xl font-bold">{schedule.blocks.length}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                  <Target className="h-4 w-4" />
                  Days until exam
                </div>
                <p className="text-2xl font-bold">{schedule.daysUntilExam}</p>
              </CardContent>
            </Card>
          </div>

          {schedule.isReset && (
            <div className="rounded-lg border bg-accent/50 px-4 py-3 text-sm text-accent-foreground">
              Psychological reset applied — the backlog has been cleared and the schedule rebuilt from your current position.
            </div>
          )}

          <div className="space-y-3">
            {schedule.blocks.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                  <BookOpen className="h-10 w-10 mb-3 opacity-40" />
                  <p className="font-medium">No study blocks scheduled</p>
                  <p className="text-sm mt-1">Add topics first, then recalculate the schedule.</p>
                </CardContent>
              </Card>
            ) : (
              schedule.blocks.map((block, i) => (
                <Card key={i} className="transition-all hover:shadow-md" data-testid={`block-${i}`}>
                  <CardContent className="pt-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <h3 className="font-semibold">{block.topicName}</h3>
                          <Badge variant="outline" className="text-xs">{block.subject}</Badge>
                          <Badge variant={block.sessionType === "practice" ? "default" : "secondary"} className="text-xs">
                            {block.sessionType}
                          </Badge>
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center gap-4 text-sm text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {block.durationMinutes}m
                            </span>
                            <span>Mastery: {Math.round(block.masteryScore * 100)}%</span>
                            <span>Priority: {block.priorityScore.toFixed(2)}</span>
                          </div>
                          <Progress value={block.masteryScore * 100} className="h-1.5" />
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => openLog({ topicId: block.topicId, topicName: block.topicName, durationMinutes: block.durationMinutes, sessionType: block.sessionType })}
                        data-testid={`button-log-block-${i}`}
                      >
                        <CheckCircle2 className="h-4 w-4 mr-1" />
                        Done
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </>
      ) : null}

      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log Study Session</DialogTitle>
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
                    <Select
                      onValueChange={(v) => field.onChange(Number(v))}
                      value={field.value ? String(field.value) : ""}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-topic">
                          <SelectValue placeholder="Select topic" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {topics?.map((t) => (
                          <SelectItem key={t.id} value={String(t.id)}>
                            {t.name} — {t.subject}
                          </SelectItem>
                        ))}
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
                          <SelectTrigger data-testid="select-session-type">
                            <SelectValue />
                          </SelectTrigger>
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
                        <FormControl>
                          <Input type="number" min="0" max="100" placeholder="72" data-testid="input-test-score" {...field} />
                        </FormControl>
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
                        <FormControl>
                          <Input type="number" min="1" placeholder="100" data-testid="input-test-score-max" {...field} />
                        </FormControl>
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
                    <FormControl>
                      <Textarea placeholder="What did you cover? Any blockers?" data-testid="textarea-notes" {...field} />
                    </FormControl>
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
