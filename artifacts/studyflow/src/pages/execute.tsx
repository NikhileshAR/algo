import { useRef, useState, useEffect, useCallback } from "react";
import { useRoute, useLocation } from "wouter";
import {
  useLogSession,
  useListSessions,
  type DailySchedule,
  getListSessionsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetPriorityTopicsQueryKey,
  getListTopicsQueryKey,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Play,
  Square,
  SkipForward,
  Coffee,
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ZapIcon,
} from "lucide-react";
import {
  type ExecutionPhase,
  type CompletionStatus,
  type UnderstandingRating,
  type MomentumState,
  COMMITMENT_WINDOW_SECONDS,
  isInCommitmentWindow,
  commitmentWindowRemainingSeconds,
  computeBreakMinutes,
  computeAdaptiveOverlay,
  computeMomentumState,
  momentumLabel,
  saveActiveExecution,
  loadActiveExecution,
  clearActiveExecution,
  loadMomentumData,
  saveMomentumData,
  saveLastRating,
  loadLastRating,
  completionRatio,
} from "@/lib/execution-engine";
import { recordManualTelemetryEvent } from "@/lib/local-db/bridge";
import { runFeedbackLoop } from "@/lib/feedback-loop";
import { getValidationRepo } from "@/lib/local-db/validation";
import { scheduleEndpointForMode, useValidationMode } from "@/lib/validation-mode";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function todayIso(): string {
  return new Date().toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RatingButton({
  value,
  label,
  selected,
  onClick,
}: {
  value: UnderstandingRating;
  label: string;
  selected: boolean;
  onClick: (v: UnderstandingRating) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={`flex-1 py-3 rounded-lg border-2 text-sm font-medium transition-all ${
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background hover:border-primary/60"
      }`}
      aria-pressed={selected}
    >
      {label}
    </button>
  );
}

const RATING_LABELS: Record<UnderstandingRating, string> = {
  1: "1 — Struggled",
  2: "2 — Partial",
  3: "3 — Okay",
  4: "4 — Good",
  5: "5 — Excellent",
};

/** Minimum minutes to log for any session, regardless of actual elapsed time. */
const MIN_SESSION_MINUTES = 1;

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Execute() {
  const [, params] = useRoute<{ blockIndex: string }>("/execute/:blockIndex");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [mode] = useValidationMode();

  const blockIndex = params?.blockIndex !== undefined ? parseInt(params.blockIndex, 10) : 0;

  const { data: schedule } = useQuery<DailySchedule>({
    queryKey: ["schedule", "today", mode],
    queryFn: () => fetch(scheduleEndpointForMode(mode)).then((r) => r.json()),
  });
  const { data: sessions } = useListSessions({ limit: 200 });
  const logSession = useLogSession();

  const blocks = Array.isArray(schedule?.blocks) ? schedule.blocks : [];
  const block = blocks[blockIndex] ?? null;
  const nextBlock = blocks[blockIndex + 1] ?? null;
  const isLastBlock = blockIndex >= blocks.length - 1;

  // Page-open timestamp for start-delay analytics
  const pageOpenedAt = useRef<number>(Date.now());

  // Phase state
  const [phase, setPhase] = useState<ExecutionPhase>("pre_start");

  // Timer
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  // Post-session inputs
  const [notes, setNotes] = useState("");
  const [completionStatus, setCompletionStatus] = useState<CompletionStatus | null>(null);
  const [selfRating, setSelfRating] = useState<UnderstandingRating | null>(null);

  // Break state
  const [breakSeconds, setBreakSeconds] = useState(0);
  const [breakElapsed, setBreakElapsed] = useState(0);
  const breakIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Momentum
  const today = todayIso();
  const momentumData = loadMomentumData(today);
  const [momentum, setMomentum] = useState<MomentumState>(
    computeMomentumState(momentumData.consecutiveCompleted, momentumData.lastWasInterrupted),
  );

  // Last rating from previous session
  const lastRating = loadLastRating();
  const adaptiveOverlay = block
    ? computeAdaptiveOverlay(lastRating, block.sessionType as "lecture" | "practice")
    : null;

  // Completed sessions today
  const completedToday = (sessions ?? []).filter(
    (s) => typeof s.studiedAt === "string" && s.studiedAt.startsWith(today),
  ).length;

  // Interrupted session detection
  const [pendingResume, setPendingResume] = useState<ReturnType<typeof loadActiveExecution>>(null);

  useEffect(() => {
    const persisted = loadActiveExecution();
    if (persisted && persisted.blockIndex === blockIndex) {
      setPendingResume(persisted);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (breakIntervalRef.current) clearInterval(breakIntervalRef.current);
    };
  }, [blockIndex]);

  // Persist active execution to sessionStorage on every tick
  useEffect(() => {
    if (phase === "active" && block) {
      saveActiveExecution({
        blockIndex,
        topicId: block.topicId,
        topicName: block.topicName,
        sessionType: block.sessionType as "lecture" | "practice",
        startedAt: startedAtRef.current,
        elapsedSeconds: elapsed,
      });
    }
  }, [phase, block, blockIndex, elapsed]);

  // ---------------------------------------------------------------------------
  // Timer controls
  // ---------------------------------------------------------------------------

  const startTimer = useCallback(() => {
    startedAtRef.current = Date.now();
    setElapsed(0);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Phase transitions
  // ---------------------------------------------------------------------------

  function handleStart() {
    clearActiveExecution();
    setPendingResume(null);
    startTimer();
    setPhase("active");
    void getValidationRepo().appendExecutionEvent({ mode, type: "started" });
  }

  function handleResume(persisted: NonNullable<ReturnType<typeof loadActiveExecution>>) {
    clearActiveExecution();
    setPendingResume(null);
    // Continue elapsed from persisted value
    setElapsed(persisted.elapsedSeconds);
    startedAtRef.current = Date.now() - persisted.elapsedSeconds * 1000;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    setPhase("active");
    void getValidationRepo().appendExecutionEvent({ mode, type: "started" });
  }

  function handleAbandonResume() {
    clearActiveExecution();
    setPendingResume(null);
    // Mark the partial session and go to post_session with partial status pre-selected
    stopTimer();
    setElapsed(pendingResume?.elapsedSeconds ?? 0);
    setCompletionStatus("partial");
    setPhase("post_session");
  }

  function handleEndSession() {
    stopTimer();
    setPhase("post_session");
  }

  function handleInterrupt() {
    stopTimer();
    // Persist current state so resume prompt shows on return
    if (block) {
      saveActiveExecution({
        blockIndex,
        topicId: block.topicId,
        topicName: block.topicName,
        sessionType: block.sessionType as "lecture" | "practice",
        startedAt: startedAtRef.current,
        elapsedSeconds: elapsed,
      });
    }
    setPhase("interrupted");
    void getValidationRepo().appendExecutionEvent({ mode, type: "interrupted" });
  }

  function handleResumeFromInterruption() {
    setPhase("active");
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  }

  function handleAbandonSession() {
    clearActiveExecution();
    stopTimer();
    setCompletionStatus("partial");
    setPhase("post_session");
  }

  function handleSaveSession() {
    if (!block || completionStatus === null || selfRating === null) return;

    const actualMinutes = Math.max(MIN_SESSION_MINUTES, Math.ceil(elapsed / 60));
    const ratio = completionRatio(completionStatus);
    const effectiveMinutes = Math.round(actualMinutes * ratio);

    // Update momentum
    const wasInterrupted = completionStatus === "no";
    const newConsecutive = wasInterrupted
      ? 0
      : momentumData.consecutiveCompleted + 1;
    const newMomentumData = {
      date: today,
      consecutiveCompleted: newConsecutive,
      lastWasInterrupted: wasInterrupted,
    };
    saveMomentumData(newMomentumData);
    setMomentum(computeMomentumState(newConsecutive, wasInterrupted));

    // Save rating for next block's adaptive overlay
    saveLastRating(selfRating);
    clearActiveExecution();

    logSession.mutate(
      {
        data: {
          topicId: block.topicId,
          sessionType: block.sessionType as "lecture" | "practice",
          durationMinutes: Math.max(1, effectiveMinutes),
          notes: notes.trim() || undefined,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["schedule", "today", mode] });
          queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetPriorityTopicsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListTopicsQueryKey() });

          void recordManualTelemetryEvent({
            topic: block.topicName,
            durationMinutes: effectiveMinutes,
            title: notes.trim() || undefined,
          });

          void runFeedbackLoop({
            topicId: String(block.topicId),
            topicName: block.topicName,
            serverMastery: block.masteryScore,
            focusedMinutes: effectiveMinutes,
          });

          if (isLastBlock) {
            setPhase("complete");
          } else {
            const suggestedBreak = computeBreakMinutes(actualMinutes, completedToday, selfRating);
            const needsBreak = suggestedBreak > 0;
            if (needsBreak) {
              setBreakSeconds(suggestedBreak * 60);
              setBreakElapsed(0);
              startBreakTimer(suggestedBreak * 60);
              setPhase("on_break");
            } else {
              navigateToNext();
            }
          }
        },
        onError: () => {
          toast({
            title: "Error logging session",
            description: "Could not save your session. Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  }

  function startBreakTimer(durationSeconds: number) {
    if (breakIntervalRef.current) clearInterval(breakIntervalRef.current);
    breakIntervalRef.current = setInterval(() => {
      setBreakElapsed((e) => {
        if (e + 1 >= durationSeconds) {
          if (breakIntervalRef.current) clearInterval(breakIntervalRef.current);
          navigateToNext();
          return durationSeconds;
        }
        return e + 1;
      });
    }, 1000);
  }

  function navigateToNext() {
    if (breakIntervalRef.current) clearInterval(breakIntervalRef.current);
    navigate(`/execute/${blockIndex + 1}`);
  }

  function handleSkipBreak() {
    if (breakIntervalRef.current) clearInterval(breakIntervalRef.current);
    navigateToNext();
  }

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const inCommitmentWindow = isInCommitmentWindow(elapsed);
  const commitmentRemaining = commitmentWindowRemainingSeconds(elapsed);
  const sessionTargetMinutes = block?.durationMinutes ?? 0;
  const progressPct = sessionTargetMinutes > 0
    ? Math.min(100, Math.round((elapsed / (sessionTargetMinutes * 60)) * 100))
    : 0;
  const breakProgressPct = breakSeconds > 0
    ? Math.min(100, Math.round((breakElapsed / breakSeconds) * 100))
    : 0;
  const breakRemaining = Math.max(0, breakSeconds - breakElapsed);

  // ---------------------------------------------------------------------------
  // Guard: no schedule
  // ---------------------------------------------------------------------------

  if (!schedule || blocks.length === 0 || !block) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-3 max-w-sm">
          <p className="text-muted-foreground">No study blocks scheduled for today.</p>
          <Button onClick={() => navigate("/schedule")}>Back to Schedule</Button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Interrupted-session resume prompt (from previous navigation away)
  // ---------------------------------------------------------------------------

  if (pendingResume) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md space-y-5">
          <div className="text-center space-y-1">
            <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto" />
            <h2 className="text-xl font-bold">Session interrupted</h2>
            <p className="text-sm text-muted-foreground">
              You were studying <span className="font-medium">{pendingResume.topicName}</span>{" "}
              ({formatTime(pendingResume.elapsedSeconds)} elapsed). Would you like to resume?
            </p>
          </div>
          <div className="space-y-2">
            <Button className="w-full" onClick={() => handleResume(pendingResume)}>
              Resume session
            </Button>
            <Button variant="outline" className="w-full" onClick={handleAbandonResume}>
              Mark partial & continue
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render by phase
  // ---------------------------------------------------------------------------

  // --- COMPLETE ---
  if (phase === "complete") {
    const mLabel = momentumLabel(momentum);
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md text-center space-y-6">
          <CheckCircle2 className="h-14 w-14 text-emerald-500 mx-auto" />
          <div>
            <h1 className="text-2xl font-bold">Mission complete</h1>
            <p className="text-muted-foreground mt-1">All study blocks for today are done.</p>
          </div>
          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-center">
            {mLabel}
          </div>
          <p className="text-sm text-muted-foreground">
            The system will prepare a fresh mission for tomorrow. Open the app then to start.
          </p>
          <Button className="w-full" onClick={() => navigate("/")}>
            Back to dashboard
          </Button>
        </div>
      </div>
    );
  }

  // --- ON BREAK ---
  if (phase === "on_break") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-1">
            <Coffee className="h-10 w-10 text-muted-foreground mx-auto" />
            <h2 className="text-xl font-bold">Short break</h2>
            <p className="text-sm text-muted-foreground">
              Step away, hydrate, rest your eyes. The next session starts automatically.
            </p>
          </div>

          <div className="text-center">
            <span className="font-mono text-5xl font-bold tabular-nums text-primary">
              {formatTime(breakRemaining)}
            </span>
          </div>

          <Progress value={breakProgressPct} className="h-2" />

          <div className="text-center text-xs text-muted-foreground">
            Up next: {nextBlock?.topicName ?? "—"} · {nextBlock?.sessionType}
          </div>

          <Button variant="outline" className="w-full" onClick={handleSkipBreak}>
            <SkipForward className="h-4 w-4 mr-2" />
            Skip break — start next session
          </Button>
        </div>
      </div>
    );
  }

  // --- INTERRUPTED ---
  if (phase === "interrupted") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md space-y-5">
          <div className="text-center space-y-1">
            <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto" />
            <h2 className="text-xl font-bold">Session paused</h2>
            <p className="text-sm text-muted-foreground">
              You have studied {formatTime(elapsed)} on{" "}
              <span className="font-medium">{block.topicName}</span>. Would you like to
              continue?
            </p>
          </div>
          <div className="space-y-2">
            <Button className="w-full" onClick={handleResumeFromInterruption}>
              Resume session
            </Button>
            <Button variant="outline" className="w-full" onClick={handleAbandonSession}>
              End now & log what I studied
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // --- POST SESSION ---
  if (phase === "post_session") {
    const canSave = completionStatus !== null && selfRating !== null;
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-lg space-y-6">
          <div className="text-center">
            <h2 className="text-xl font-bold">Session complete</h2>
            <p className="text-sm text-muted-foreground">
              {block.topicName} · {formatTime(elapsed)} studied
            </p>
          </div>

          {/* Completion check */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Did you complete the session?</p>
            <div className="flex gap-2">
              {(["yes", "partial", "no"] as CompletionStatus[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setCompletionStatus(s)}
                  className={`flex-1 py-2.5 rounded-lg border-2 text-sm font-medium capitalize transition-all ${
                    completionStatus === s
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:border-primary/60"
                  }`}
                >
                  {s === "yes" ? "Yes ✓" : s === "partial" ? "Partial" : "No"}
                </button>
              ))}
            </div>
          </div>

          {/* Self-rating */}
          <div className="space-y-2">
            <p className="text-sm font-medium">How well did you understand the material?</p>
            <div className="flex gap-1.5">
              {([1, 2, 3, 4, 5] as UnderstandingRating[]).map((v) => (
                <RatingButton
                  key={v}
                  value={v}
                  label={String(v)}
                  selected={selfRating === v}
                  onClick={setSelfRating}
                />
              ))}
            </div>
            {selfRating !== null && (
              <p className="text-xs text-muted-foreground text-center">
                {RATING_LABELS[selfRating]}
              </p>
            )}
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="session-notes">
              Notes <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <Textarea
              id="session-notes"
              placeholder="What did you cover? Any blockers or key insights?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>

          <Button
            className="w-full"
            disabled={!canSave || logSession.isPending}
            onClick={handleSaveSession}
          >
            {logSession.isPending ? "Saving..." : isLastBlock ? "Save & complete mission" : "Save & continue"}
            {!logSession.isPending && <ChevronRight className="h-4 w-4 ml-1" />}
          </Button>

          <button
            type="button"
            className="w-full text-xs text-muted-foreground hover:text-foreground text-center"
            onClick={() => navigate("/schedule")}
          >
            Exit to schedule
          </button>
        </div>
      </div>
    );
  }

  // --- ACTIVE ---
  if (phase === "active") {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        {/* Minimal header */}
        <header className="flex items-center justify-between px-4 py-3 border-b max-w-2xl mx-auto w-full">
          <button
            type="button"
            onClick={handleInterrupt}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Pause
          </button>
          <span className="text-xs text-muted-foreground">
            {block.topicName} · {block.sessionType}
          </span>
          <Badge variant="outline" className="text-xs">
            Block {blockIndex + 1}/{blocks.length}
          </Badge>
        </header>

        {/* Main focus area */}
        <main className="flex-1 flex flex-col items-center justify-center px-4 py-8">
          <div className="w-full max-w-xl space-y-8">
            {/* Big timer */}
            <div className="text-center space-y-2">
              <div className="relative">
                <span
                  className="font-mono font-bold tabular-nums text-primary"
                  style={{ fontSize: "clamp(3rem, 8vw, 6rem)" }}
                >
                  {formatTime(elapsed)}
                </span>
                {inCommitmentWindow && (
                  <div className="mt-1">
                    <span className="text-xs text-muted-foreground">
                      Commit to {formatTime(commitmentRemaining)} more
                    </span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-center gap-2">
                <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                <span className="text-sm text-muted-foreground">Focused session in progress</span>
              </div>
            </div>

            {/* Session progress toward target */}
            <div className="space-y-1.5">
              <Progress value={progressPct} className="h-1.5" />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{progressPct}% of planned {sessionTargetMinutes}m</span>
                <span className="flex items-center gap-1">
                  <ZapIcon className="h-3 w-3" />
                  {momentumLabel(momentum)}
                </span>
              </div>
            </div>

            {/* Optional notes (non-distracting, collapsible) */}
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground text-xs">
                Add quick note (optional)
              </summary>
              <Textarea
                className="mt-2"
                placeholder="Capture a key idea or a question to follow up on..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </details>

            {/* End session control */}
            <div className="space-y-2">
              {inCommitmentWindow ? (
                <Button
                  variant="outline"
                  className="w-full text-muted-foreground"
                  onClick={handleEndSession}
                  title={`Commit to ${formatTime(commitmentRemaining)} more for best results`}
                >
                  <Square className="h-4 w-4 mr-2 fill-current" />
                  End session early
                  <span className="ml-2 text-xs opacity-60">({formatTime(commitmentRemaining)} left in commitment)</span>
                </Button>
              ) : (
                <Button className="w-full" onClick={handleEndSession}>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  End session
                </Button>
              )}
            </div>
          </div>
        </main>
      </div>
    );
  }

  // --- PRE_START (default) ---
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-lg space-y-6">
        {/* Back link */}
        <button
          type="button"
          onClick={() => navigate("/schedule")}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to schedule
        </button>

        {/* Block summary */}
        <div className="rounded-2xl border bg-card p-6 space-y-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground uppercase tracking-wide">
                Block {blockIndex + 1} of {blocks.length}
              </span>
              <Badge variant={block.sessionType === "practice" ? "default" : "secondary"}>
                {block.sessionType}
              </Badge>
            </div>
            <h1 className="text-2xl font-bold">{block.topicName}</h1>
            <p className="text-muted-foreground text-sm">{block.subject}</p>
          </div>

          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{block.durationMinutes}</span> min planned
            </span>
            <span>
              Mastery: <span className="font-semibold text-foreground">{Math.round(block.masteryScore * 100)}%</span>
            </span>
          </div>

          {/* Adaptive overlay from previous session */}
          {adaptiveOverlay && (
            <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
              {adaptiveOverlay}
            </div>
          )}

          {/* Momentum state */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ZapIcon className="h-3.5 w-3.5" />
            {momentumLabel(momentum)}
          </div>

          {/* Micro-commitment framing */}
          <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-sm">
            <p className="font-medium text-foreground">
              Just study for 10 minutes first — you can stop after that.
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Once you start, the system handles everything else.
            </p>
          </div>
        </div>

        {/* Single primary CTA */}
        <Button className="w-full text-base py-6" size="lg" onClick={handleStart}>
          <Play className="h-5 w-5 mr-2 fill-current" />
          Start session
        </Button>
      </div>
    </div>
  );
}
