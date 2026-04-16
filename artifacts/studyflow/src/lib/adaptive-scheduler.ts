import { estimateRetention, type TopicMasteryState } from "./local-db/knowledge-state";
import type { TopicDaySummary } from "./local-db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DifficultyAdjustment = "down" | "stable" | "up";
export type SessionKind = "revision" | "active_recall" | "weak_repair" | "new_learning";

export interface StudyPlanItem {
  topicId: string;
  topicName: string;
  /** 0–100 scheduling urgency. Higher = schedule sooner. */
  priority: number;
  recommendedMinutes: number;
  sessionType: SessionKind;
  difficultyAdjustment: DifficultyAdjustment;
  reasonTags: string[];
}

export interface AdaptiveInput {
  topicId: string;
  topicName: string;
  /** Current mastery from server or local estimate (0–1). */
  serverMastery: number;
  /** Days until the exam from today. 0 if exam passed. */
  daysUntilExam: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum retention to avoid "at risk" escalation. */
const RETENTION_AT_RISK_THRESHOLD = 0.4;
/** Quality below this triggers a difficulty-down. */
const LOW_QUALITY_THRESHOLD = 0.4;
/** Quality above this triggers a difficulty-up. */
const HIGH_QUALITY_THRESHOLD = 0.75;
/** Maximum tasks in a daily plan. */
const MAX_PLAN_TASKS = 7;
/** Minimum tasks in a daily plan. */
const MIN_PLAN_TASKS = 3;
/** Default session length in minutes. */
const DEFAULT_SESSION_MINUTES = 30;
/** Long session minutes for high-priority topics. */
const LONG_SESSION_MINUTES = 45;
/** Short session for consolidation or light review. */
const SHORT_SESSION_MINUTES = 20;

// ---------------------------------------------------------------------------
// Internal scoring
// ---------------------------------------------------------------------------

interface ScoredTopic extends AdaptiveInput {
  state: TopicMasteryState;
  recentSummary: TopicDaySummary | null;
  retention: number;
  urgency: number;
}

function computeUrgency(
  state: TopicMasteryState,
  serverMastery: number,
  recentSummary: TopicDaySummary | null,
  daysUntilExam: number,
): number {
  const retention = estimateRetention(state);
  const blendedMastery = (state.mastery * 0.6 + serverMastery * 0.4);
  const forgettingRisk = 1 - retention;
  const masteryGap = 1 - blendedMastery;
  const examProximityFactor = daysUntilExam <= 0 ? 1 : Math.min(1, 30 / (daysUntilExam + 1));

  // Boost urgency for topics with high telemetry fragmentation (poor comprehension)
  const fragmentationBoost = recentSummary ? recentSummary.fragmentation * 0.2 : 0;
  // Reduce urgency if recently studied with high quality (already covered today)
  const recentHighQualityDiscount = recentSummary && recentSummary.qualityScore > HIGH_QUALITY_THRESHOLD && recentSummary.focusedMinutes > 20 ? 0.5 : 1;

  const raw =
    forgettingRisk * 0.4 +
    masteryGap * 0.35 +
    examProximityFactor * 0.25 +
    fragmentationBoost;

  return Math.min(100, Math.round(raw * recentHighQualityDiscount * 100));
}

function chooseDifficultyAdjustment(
  state: TopicMasteryState,
  recentSummary: TopicDaySummary | null,
): DifficultyAdjustment {
  if (!recentSummary) {
    return "stable";
  }
  if (recentSummary.qualityScore < LOW_QUALITY_THRESHOLD || recentSummary.focusRatio < 0.4) {
    return "down";
  }
  if (recentSummary.qualityScore > HIGH_QUALITY_THRESHOLD && state.mastery > 0.6) {
    return "up";
  }
  return "stable";
}

function chooseSessionType(
  state: TopicMasteryState,
  retention: number,
  recentSummary: TopicDaySummary | null,
): SessionKind {
  if (state.mastery < 0.25 && state.practiceCount < 3) {
    return "new_learning";
  }
  if (state.mastery < 0.4) {
    return "weak_repair";
  }
  if (retention < RETENTION_AT_RISK_THRESHOLD) {
    return "active_recall";
  }
  // High video dependency → force active recall
  if (recentSummary && recentSummary.videoEngagementRatio > 0.6 && recentSummary.interactionDensity < 0.3) {
    return "active_recall";
  }
  // High fragmentation → revision to consolidate
  if (recentSummary && recentSummary.fragmentation > 0.5) {
    return "revision";
  }
  return "revision";
}

function buildReasonTags(
  state: TopicMasteryState,
  retention: number,
  summary: TopicDaySummary | null,
  diffAdj: DifficultyAdjustment,
  sessionType: SessionKind,
): string[] {
  const tags: string[] = [];

  if (retention < RETENTION_AT_RISK_THRESHOLD) {
    tags.push("at risk of forgetting");
  }
  if (state.mastery < 0.4) {
    tags.push("mastery gap");
  }
  if (summary && summary.fragmentation > 0.5) {
    tags.push("fragmented sessions");
  }
  if (summary && summary.videoEngagementRatio > 0.6 && summary.interactionDensity < 0.3) {
    tags.push("video-heavy, low recall");
  }
  if (summary && summary.focusRatio < 0.4) {
    tags.push("low focus ratio");
  }
  if (diffAdj === "up") {
    tags.push("strong performance — push harder");
  }
  if (diffAdj === "down") {
    tags.push("difficulty reduced to rebuild confidence");
  }
  if (sessionType === "new_learning") {
    tags.push("new topic");
  }
  if (sessionType === "active_recall") {
    tags.push("spaced recall due");
  }
  return tags;
}

function recommendedMinutes(
  urgency: number,
  sessionType: SessionKind,
  daysUntilExam: number,
): number {
  if (sessionType === "weak_repair") {
    return LONG_SESSION_MINUTES;
  }
  if (sessionType === "new_learning") {
    return DEFAULT_SESSION_MINUTES;
  }
  if (urgency >= 70) {
    return LONG_SESSION_MINUTES;
  }
  if (urgency <= 30 && daysUntilExam > 30) {
    return SHORT_SESSION_MINUTES;
  }
  return DEFAULT_SESSION_MINUTES;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generates a daily adaptive plan from topic metadata, mastery states, and
 * recent telemetry summaries. Returns at most MAX_PLAN_TASKS items, sorted by
 * urgency descending.
 *
 * Pure function — no side effects / no I/O.
 */
export function computeAdaptivePlan(
  topics: AdaptiveInput[],
  masteryStates: Map<string, TopicMasteryState>,
  recentSummaries: Map<string, TopicDaySummary>,
): StudyPlanItem[] {
  if (topics.length === 0) {
    return [];
  }

  const scored: ScoredTopic[] = topics.map((t) => {
    const state = masteryStates.get(t.topicId) ?? {
      topicId: t.topicId,
      mastery: t.serverMastery,
      retentionDecay: 0.2,
      lastPracticed: 0,
      practiceCount: 0,
    };
    const recentSummary = recentSummaries.get(t.topicId) ?? null;
    const retention = estimateRetention(state);
    const urgency = computeUrgency(state, t.serverMastery, recentSummary, t.daysUntilExam);
    return { ...t, state, recentSummary, retention, urgency };
  });

  // Sort by urgency descending
  scored.sort((a, b) => b.urgency - a.urgency);

  // Attempt to include at least one different session type for variety before capping.
  const sessionTypes = new Set(scored.slice(0, MAX_PLAN_TASKS).map((s) => chooseSessionType(s.state, s.retention, s.recentSummary)));
  let candidates = scored.slice(0, MAX_PLAN_TASKS);
  if (candidates.length >= MIN_PLAN_TASKS && sessionTypes.size === 1 && scored.length > MAX_PLAN_TASKS) {
    const extra = scored.slice(MAX_PLAN_TASKS).find((t) => {
      const k = chooseSessionType(t.state, t.retention, t.recentSummary);
      return !sessionTypes.has(k);
    });
    if (extra) {
      // Replace the lowest-urgency candidate with the diverse pick
      candidates = [...candidates.slice(0, MAX_PLAN_TASKS - 1), extra];
    }
  }

  const selected = candidates;

  return selected.map((t) => {
    const diffAdj = chooseDifficultyAdjustment(t.state, t.recentSummary);
    const sessionType = chooseSessionType(t.state, t.retention, t.recentSummary);
    const reasonTags = buildReasonTags(t.state, t.retention, t.recentSummary, diffAdj, sessionType);
    const minutes = recommendedMinutes(t.urgency, sessionType, t.daysUntilExam);

    return {
      topicId: t.topicId,
      topicName: t.topicName,
      priority: t.urgency,
      recommendedMinutes: minutes,
      sessionType,
      difficultyAdjustment: diffAdj,
      reasonTags,
    };
  });
}
