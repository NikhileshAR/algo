import { estimateRetention, type TopicMasteryState } from "./local-db/knowledge-state";
import type { TopicDaySummary } from "./local-db/schema";
import { computeAdaptivePlan, type AdaptiveInput, type StudyPlanItem } from "./adaptive-scheduler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FocusTrend = "improving" | "stable" | "declining";

export interface Recommendation {
  topicId: string;
  topicName: string;
  reason: string;
}

export interface SmartRecommendations {
  /** The single topic to study right now based on urgency. */
  nextBestTopic: Recommendation | null;
  /** Topic with the lowest blended mastery. */
  weakestSkill: (Recommendation & { masteryPct: number }) | null;
  /** Topics whose estimated retention has dropped below the warning threshold. */
  atRiskOfForgetting: Array<Recommendation & { retentionPct: number }>;
  /** Topics where the user is significantly over-represented relative to others. */
  overstudiedTopics: Recommendation[];
  /** Computed trend from focus ratios over the last several days. */
  focusTrend: FocusTrend;
  /** Headline copy for the focus trend. */
  focusTrendSummary: string;
  /** Pre-computed plan for tomorrow. */
  tomorrowPlan: StudyPlanItem[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AT_RISK_RETENTION_THRESHOLD = 0.4;
const OVERSTUDIED_RATIO_THRESHOLD = 2.5; // 2.5× the average focused minutes

// ---------------------------------------------------------------------------
// Focus trend helpers
// ---------------------------------------------------------------------------

/**
 * Derives the user's focus trend from a list of per-day global focus ratios
 * (0–1), ordered oldest-first.
 */
export function computeFocusTrend(focusRatiosByDay: number[]): FocusTrend {
  if (focusRatiosByDay.length < 2) {
    return "stable";
  }
  const half = Math.ceil(focusRatiosByDay.length / 2);
  const earlier = focusRatiosByDay.slice(0, half);
  const recent = focusRatiosByDay.slice(half);

  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const diff = avg(recent) - avg(earlier);

  if (diff > 0.08) {
    return "improving";
  }
  if (diff < -0.08) {
    return "declining";
  }
  return "stable";
}

function focusTrendSummary(trend: FocusTrend, recent: number[]): string {
  const pct = recent.length > 0 ? Math.round((recent.reduce((s, v) => s + v, 0) / recent.length) * 100) : 0;
  switch (trend) {
    case "improving":
      return `Focus trending up — averaging ${pct}% over recent sessions. Keep it going.`;
    case "declining":
      return `Focus trending down — averaging ${pct}% recently. Try shorter, distraction-free sessions.`;
    default:
      return `Focus is steady at around ${pct}%. Consistent effort is building long-term capacity.`;
  }
}

// ---------------------------------------------------------------------------
// Main computation (pure)
// ---------------------------------------------------------------------------

export interface RecommendationContext {
  topics: AdaptiveInput[];
  masteryStates: Map<string, TopicMasteryState>;
  /** Today's telemetry summaries keyed by topicId. */
  todaySummaries: Map<string, TopicDaySummary>;
  /**
   * Global focus ratios for the past N days, oldest-first.
   * Used to determine the focus trend.
   */
  recentFocusRatios: number[];
}

export function computeSmartRecommendations(ctx: RecommendationContext): SmartRecommendations {
  const { topics, masteryStates, todaySummaries, recentFocusRatios } = ctx;

  const focusTrend = computeFocusTrend(recentFocusRatios);
  const recentHalf = recentFocusRatios.slice(Math.ceil(recentFocusRatios.length / 2));
  const focusTrendMsg = focusTrendSummary(focusTrend, recentHalf);

  if (topics.length === 0) {
    return {
      nextBestTopic: null,
      weakestSkill: null,
      atRiskOfForgetting: [],
      overstudiedTopics: [],
      focusTrend,
      focusTrendSummary: focusTrendMsg,
      tomorrowPlan: [],
    };
  }

  // Build blended mastery for each topic
  const blended = (topicId: string, serverMastery: number) => {
    const s = masteryStates.get(topicId);
    return s ? s.mastery * 0.6 + serverMastery * 0.4 : serverMastery;
  };

  // ---------- Next best topic ----------
  const todayPlan = computeAdaptivePlan(topics, masteryStates, todaySummaries);
  const nextBestTopic: Recommendation | null = todayPlan[0]
    ? {
        topicId: todayPlan[0].topicId,
        topicName: todayPlan[0].topicName,
        reason: todayPlan[0].reasonTags[0] ?? "highest urgency right now",
      }
    : null;

  // ---------- Weakest skill ----------
  const byMastery = [...topics].sort((a, b) => blended(a.topicId, a.serverMastery) - blended(b.topicId, b.serverMastery));
  const weakest = byMastery[0] ?? null;
  const weakestSkill = weakest
    ? {
        topicId: weakest.topicId,
        topicName: weakest.topicName,
        masteryPct: Math.round(blended(weakest.topicId, weakest.serverMastery) * 100),
        reason: `Lowest mastery at ${Math.round(blended(weakest.topicId, weakest.serverMastery) * 100)}% — needs dedicated practice`,
      }
    : null;

  // ---------- At risk of forgetting ----------
  const atRiskOfForgetting = topics
    .filter((t) => {
      const s = masteryStates.get(t.topicId);
      if (!s || s.lastPracticed === 0) {
        return false;
      }
      return estimateRetention(s) < AT_RISK_RETENTION_THRESHOLD;
    })
    .map((t) => {
      const s = masteryStates.get(t.topicId)!;
      const ret = estimateRetention(s);
      const daysSince = Math.round((Date.now() - s.lastPracticed) / 86_400_000);
      return {
        topicId: t.topicId,
        topicName: t.topicName,
        retentionPct: Math.round(ret * 100),
        reason: `Not practiced in ${daysSince} day${daysSince !== 1 ? "s" : ""} — retention estimated at ${Math.round(ret * 100)}%`,
      };
    })
    .sort((a, b) => a.retentionPct - b.retentionPct)
    .slice(0, 5);

  // ---------- Overstudied topics ----------
  const totalFocused = topics.reduce((sum, t) => sum + (todaySummaries.get(t.topicId)?.focusedMinutes ?? 0), 0);
  const avgMinutes = topics.length > 0 ? totalFocused / topics.length : 0;

  const overstudiedTopics: Recommendation[] = [];
  if (avgMinutes > 0) {
    for (const t of topics) {
      const mins = todaySummaries.get(t.topicId)?.focusedMinutes ?? 0;
      if (mins > avgMinutes * OVERSTUDIED_RATIO_THRESHOLD && mins > 30) {
        overstudiedTopics.push({
          topicId: t.topicId,
          topicName: t.topicName,
          reason: `${Math.round(mins)}m today — ${Math.round(mins / avgMinutes)}× the average; consider redistributing`,
        });
      }
    }
  }

  // ---------- Tomorrow's plan ----------
  // Use same inputs as today but assume today's focused minutes reset to 0
  const emptyTodaySummaries = new Map<string, TopicDaySummary>();
  const tomorrowPlan = computeAdaptivePlan(topics, masteryStates, emptyTodaySummaries);

  return {
    nextBestTopic,
    weakestSkill,
    atRiskOfForgetting,
    overstudiedTopics,
    focusTrend,
    focusTrendSummary: focusTrendMsg,
    tomorrowPlan,
  };
}
