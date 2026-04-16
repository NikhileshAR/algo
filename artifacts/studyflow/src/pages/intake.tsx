/**
 * Intake — Phase 2
 *
 * Chat-style onboarding page. Replaces the old form-based onboarding.
 * Drives the IntakeEngine state machine through a conversation and commits
 * the result to IndexedDB when the user confirms.
 *
 * Key behaviours:
 *   - Redirects to "/" immediately if a profile already exists
 *   - Bot messages appear with a 600 ms typing delay (staggered)
 *   - Quick-reply buttons let the user pick common responses without typing
 *   - On phase "complete": writes profile + topics to IndexedDB, navigates to "/"
 *   - Zero server calls — entirely local
 */

import { useEffect, useRef, useState, useCallback, type ReactNode, type KeyboardEvent } from "react";
import { useLocation } from "wouter";
import { Send, Loader2, Bot, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { useLocalDb, type LocalDbContextValue } from "@/context/LocalDbContext";
import {
  processUserInput,
  createInitialState,
  getWelcomeMessages,
  intakeProgress,
  userMsg,
  type ChatMessage,
  type IntakeState,
} from "@/lib/intake/intake-engine";

// ─── Inline markdown renderer ─────────────────────────────────────────────────
// Converts **bold** and *italic* to JSX without a full markdown library.

function renderContent(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return (
      <span key={i}>
        {part.split("\n").map((line, li, arr) => (
          <span key={li}>
            {line}
            {li < arr.length - 1 && <br />}
          </span>
        ))}
      </span>
    );
  });
}

// ─── Chat bubble ──────────────────────────────────────────────────────────────

function BotBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="flex items-start gap-3 max-w-[85%]">
      <div className="flex-shrink-0 h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
        <Bot className="h-4 w-4" />
      </div>
      <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-3 text-sm leading-relaxed">
        {renderContent(message.content)}
      </div>
    </div>
  );
}

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="flex items-start gap-3 max-w-[85%] ml-auto flex-row-reverse">
      <div className="flex-shrink-0 h-8 w-8 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center">
        <User className="h-4 w-4" />
      </div>
      <div className="rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-4 py-3 text-sm leading-relaxed">
        {message.content}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-start gap-3 max-w-[85%]">
      <div className="flex-shrink-0 h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
        <Bot className="h-4 w-4" />
      </div>
      <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-3 text-sm">
        <span className="flex gap-1 items-center h-4">
          <span className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
          <span className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
          <span className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
        </span>
      </div>
    </div>
  );
}

// ─── DB commit ────────────────────────────────────────────────────────────────

async function commitIntake(
  state: IntakeState,
  saveProfile: LocalDbContextValue["saveProfile"],
  addTopic: LocalDbContextValue["addTopic"],
  updateTopic: LocalDbContextValue["updateTopic"],
): Promise<void> {
  // 1. Save profile
  await saveProfile({
    name: state.name,
    examName: state.examName,
    examDate: state.examDate || new Date(Date.now() + 90 * 86_400_000).toISOString().split("T")[0],
    dailyTargetHours: state.dailyHours,
    capacityScore: state.dailyHours,
    disciplineScore: 0.8,
    distractionScore: 0.1,
    activePracticeRatio: 0.5,
    overrideCount: 0,
  });

  // 2. Create topics (prerequisiteNames resolved after all are created)
  const nameToId = new Map<string, string>();
  for (const topicData of state.topics) {
    const topic = await addTopic({
      name: topicData.name,
      subject: topicData.subject,
      masteryScore: topicData.masteryScore,
      difficultyLevel: topicData.difficulty,
      estimatedHours: topicData.estimatedHours,
      prerequisites: [],  // resolved in step 3
      isCompleted: false,
      lastStudiedAt: null,
    });
    nameToId.set(topicData.name.toLowerCase(), topic.id);
  }

  // 3. Resolve prerequisites and set confidenceScore
  for (const topicData of state.topics) {
    const id = nameToId.get(topicData.name.toLowerCase());
    if (!id) continue;

    const prereqIds = topicData.prerequisiteNames
      .map((n) => nameToId.get(n.toLowerCase()))
      .filter((v): v is string => v !== undefined);

    await updateTopic(id, {
      prerequisites: prereqIds,
      confidenceScore: topicData.confidenceScore,
    });
  }
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Intake() {
  const [, setLocation] = useLocation();
  const { profile, ready, saveProfile, addTopic, updateTopic } = useLocalDb();

  // Engine state
  const [engineState, setEngineState] = useState<IntakeState>(createInitialState);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const committingRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Redirect if already onboarded
  useEffect(() => {
    if (ready && profile) {
      setLocation("/");
    }
  }, [ready, profile, setLocation]);

  // Show welcome messages on first render
  useEffect(() => {
    if (!ready) return;
    const welcome = getWelcomeMessages();
    setMessages(welcome);
  }, [ready]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  // Commit to DB when phase reaches "complete"
  useEffect(() => {
    if (engineState.phase !== "complete" || committingRef.current) return;
    committingRef.current = true;
    setIsCommitting(true);

    commitIntake(engineState, saveProfile, addTopic, updateTopic)
      .then(() => {
        setLocation("/");
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to initialize. Please try again.";
        setCommitError(msg);
        setIsCommitting(false);
        committingRef.current = false;
      });
  }, [engineState.phase, engineState, saveProfile, addTopic, updateTopic, setLocation]);

  // Stagger bot messages with typing indicator
  const showBotMessages = useCallback((msgs: ChatMessage[]) => {
    // Clear any pending timers
    typingTimersRef.current.forEach(clearTimeout);
    typingTimersRef.current = [];

    setIsTyping(true);

    msgs.forEach((msg, i) => {
      const delay = 600 + i * 500;
      const t1 = setTimeout(() => {
        setMessages((prev) => [...prev, msg]);
        if (i === msgs.length - 1) setIsTyping(false);
      }, delay);
      typingTimersRef.current.push(t1);
    });
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => typingTimersRef.current.forEach(clearTimeout);
  }, []);

  const handleSend = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isTyping || engineState.phase === "complete") return;

      const uMsg = userMsg(trimmed);
      setMessages((prev) => [...prev, uMsg]);
      setInput("");

      const result = processUserInput(engineState, trimmed);
      setEngineState(result.newState);

      if (result.botMessages.length > 0) {
        showBotMessages(result.botMessages);
      }
    },
    [engineState, isTyping, showBotMessages],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  // The last bot message may carry quick-reply options
  const lastBotMessage = [...messages].reverse().find((m) => m.role === "bot");
  const quickReplies =
    !isTyping && lastBotMessage?.options ? lastBotMessage.options : [];

  const progress = intakeProgress(engineState.phase);

  if (!ready) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* ── Header ── */}
      <header className="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm">
              S
            </div>
            <div>
              <p className="text-sm font-semibold leading-none">StudyFlow</p>
              <p className="text-xs text-muted-foreground">Initial Setup</p>
            </div>
          </div>
          <div className="flex-1 max-w-48">
            <div className="flex items-center gap-2">
              <Progress value={progress * 100} className="h-1.5" />
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {Math.round(progress * 100)}%
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ── Message list ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-6 flex flex-col gap-4">
          {messages.map((msg) =>
            msg.role === "bot" ? (
              <BotBubble key={msg.id} message={msg} />
            ) : (
              <UserBubble key={msg.id} message={msg} />
            ),
          )}

          {isTyping && <TypingIndicator />}

          {commitError && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {commitError}
              <Button
                size="sm"
                variant="outline"
                className="ml-3"
                onClick={() => {
                  committingRef.current = false;
                  setCommitError(null);
                  setEngineState((s) => ({ ...s, phase: "confirm" }));
                }}
              >
                Retry
              </Button>
            </div>
          )}

          {isCommitting && !commitError && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground px-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving your profile and curriculum…
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      {/* ── Quick-reply buttons ── */}
      {quickReplies.length > 0 && (
        <div className="border-t bg-background/95 backdrop-blur">
          <div className="max-w-2xl mx-auto px-4 py-2 flex flex-wrap gap-2">
            {quickReplies.map((opt) => (
              <Button
                key={opt}
                variant="outline"
                size="sm"
                className="rounded-full text-xs h-8"
                onClick={() => handleSend(opt)}
                disabled={isTyping || engineState.phase === "complete"}
              >
                {opt}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* ── Input area ── */}
      <div className="border-t bg-background p-4">
        <div className="max-w-2xl mx-auto flex items-end gap-2">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              engineState.phase === "complete"
                ? "Setting up your workspace…"
                : "Type your response… (Enter to send)"
            }
            className="resize-none min-h-[44px] max-h-32 text-sm"
            rows={1}
            disabled={isTyping || engineState.phase === "complete" || isCommitting}
          />
          <Button
            size="icon"
            className="h-11 w-11 flex-shrink-0"
            onClick={() => handleSend(input)}
            disabled={
              !input.trim() ||
              isTyping ||
              engineState.phase === "complete" ||
              isCommitting
            }
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="max-w-2xl mx-auto mt-1.5 text-xs text-muted-foreground text-center">
          Shift+Enter for new line · Enter to send · All data stays on your device
        </p>
      </div>
    </div>
  );
}
