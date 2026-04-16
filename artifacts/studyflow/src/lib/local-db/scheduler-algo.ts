/**
 * Pure scheduling algorithm — Phase 1
 *
 * Takes a SchedulerInput (profile + topics + telemetry summaries) and
 * produces a DailySchedule. No I/O, no async — runs identically on the
 * main thread or inside a Web Worker.
 *
 * Algorithms:
 *   - Ebbinghaus forgetting-curve retention decay on mastery
 *   - Priority scoring: urgency × knowledge-gap × difficulty × recency-boost
 *   - Geometric capacity scaling: K_eff = K × (0.6 + 0.4 × D)
 *   - Incremental mastery update: online Bayesian average
 *   - Distraction-adjusted discipline: D = focusedActual / scheduled
 */

import type {
  SchedulerInput,
  SchedulerResult,
  LocalDailySchedule,
  LocalStudentProfile,
  LocalTopic,
  ScheduleBlock,
  TelemetrySummary,
} from "./schema";

// ─── Domain constants ─────────────────────────────────────────────────────────

/**
 * Minimum mastery score a prerequisite topic must reach before its dependant
 * topic is considered unlocked in the schedule.
 */
export const PREREQUISITE_MASTERY_THRESHOLD = 0.6;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function daysSince(isoDate: string | null): number {
  if (!isoDate) return 999;
  const diff = Date.now() - new Date(isoDate).getTime();
  return Math.floor(diff / 86_400_000);
}

function daysUntil(examDateStr: string): number {
  const diff = new Date(examDateStr).getTime() - Date.now();
  return Math.max(Math.ceil(diff / 86_400_000), 0);
}

/**
 * Ebbinghaus forgetting curve: R = e^(−t / S)
 * Stability S scales with mastery so well-mastered topics retain longer.
 *   mastery = 0  → S =  3 days
 *   mastery = 1  → S = 21 days
 */
function forgettingRetention(mastery: number, daysDormant: number): number {
  const stability = 3 + mastery * 18;
  return Math.exp(-daysDormant / stability);
}

/**
 * Priority score for a topic. Higher → schedule sooner.
 *
 * P = urgency × knowledgeGap × difficultyWeight × disciplineFactor × recencyBoost
 *
 * Blocked topics (prerequisites unmet) receive P = 0.
 */
function computePriority(
  topic: LocalTopic,
  daysToExam: number,
  disciplineScore: number,
): number {
  const dormant = daysSince(topic.lastStudiedAt);
  const retention = forgettingRetention(topic.masteryScore, dormant);
  const effectiveMastery = topic.masteryScore * retention;

  const urgency = daysToExam > 0 ? topic.estimatedHours / daysToExam : topic.estimatedHours;
  const knowledgeGap = 1 - effectiveMastery;
  const difficultyWeight = topic.difficultyLevel / 5;
  const disciplineFactor = 1 / Math.max(disciplineScore, 0.1);
  const recencyBoost = dormant > 7 ? 1 + (dormant - 7) / 14 : 1;

  return urgency * knowledgeGap * difficultyWeight * disciplineFactor * recencyBoost;
}

/**
 * Effective scheduled hours for the day.
 * K_eff = K × (0.6 + 0.4 × D)
 * A perfect discipline score (D=1) yields full capacity; D=0 yields 60%.
 */
function geometricCapacity(K: number, D: number): number {
  return K * (0.6 + 0.4 * D);
}

/**
 * Update capacity using exponential moving average:
 *   K(t+1) = 0.8 × K(t) + 0.2 × actual_hours
 *
 * Weighted by session quality so low-quality sessions contribute less.
 */
function updateCapacity(K: number, actualHours: number, qualityWeight = 1): number {
  const weighted = actualHours * qualityWeight;
  return 0.8 * K + 0.2 * weighted;
}

/**
 * Update discipline score from telemetry data:
 *   D = totalFocusedMinutes / scheduledMinutes  (capped at 1.0)
 */
function updateDiscipline(
  scheduledHours: number,
  summaries: TelemetrySummary[],
): number {
  const scheduledMinutes = scheduledHours * 60;
  if (scheduledMinutes <= 0) return 1;
  const actualFocused = summaries.reduce((sum, s) => sum + s.focusedMinutes, 0);
  return Math.min(actualFocused / scheduledMinutes, 1);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function computeSchedule(input: SchedulerInput): SchedulerResult {
  const { profile, topics, recentSummaries, targetDate } = input;

  const daysToExam = daysUntil(profile.examDate);
  const topicMap = new Map(topics.map((t) => [t.id, t]));

  // ── Update K and D from yesterday's telemetry ──────────────────────────────
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
  const yesterdaySummaries = recentSummaries.filter((s) => s.date === yesterday);

  // Previous day's schedule (if available from recentSummaries context)
  const previousScheduledHours = profile.capacityScore; // best proxy without stored yesterday schedule
  const newDiscipline = yesterdaySummaries.length > 0
    ? updateDiscipline(previousScheduledHours, yesterdaySummaries)
    : profile.disciplineScore;

  // Note: previousScheduledHours uses the current capacityScore as the best
  // available proxy for yesterday's scheduled load.  A dedicated stored field
  // would be more accurate but capacityScore (smoothed actual hours) is close
  // enough for the purposes of this update and avoids extra storage.

  const yesterdayActualHours = yesterdaySummaries.reduce(
    (sum, s) => sum + s.focusedMinutes / 60,
    0,
  );
  const avgQuality = yesterdaySummaries.length > 0
    ? yesterdaySummaries.reduce((s, e) => s + e.qualityScore, 0) / yesterdaySummaries.length
    : 1;
  const newCapacity = yesterdayActualHours > 0
    ? updateCapacity(profile.capacityScore, yesterdayActualHours, avgQuality)
    : profile.capacityScore;

  const updatedProfile: Pick<LocalStudentProfile, "capacityScore" | "disciplineScore"> = {
    capacityScore: newCapacity,
    disciplineScore: newDiscipline,
  };

  // ── Compute scheduled hours for today ────────────────────────────────────
  const scheduledHours = geometricCapacity(newCapacity, newDiscipline);
  const totalMinutes = Math.round(scheduledHours * 60);

  // ── Determine topic eligibility and priorities ────────────────────────────
  const scored = topics
    .filter((t) => !t.isCompleted)
    .map((t) => {
      const deps = t.prerequisites;
      const allDepsUnlocked = deps.every((depId) => {
        const dep = topicMap.get(depId);
        return dep ? dep.masteryScore >= PREREQUISITE_MASTERY_THRESHOLD || dep.isCompleted : true;
      });

      const priority = allDepsUnlocked
        ? computePriority(t, daysToExam, newDiscipline)
        : 0;

      return { ...t, priority, allDepsUnlocked };
    })
    .sort((a, b) => b.priority - a.priority);

  // ── Build schedule blocks ─────────────────────────────────────────────────
  const blocks: ScheduleBlock[] = [];
  let usedMinutes = 0;

  for (const topic of scored) {
    if (usedMinutes >= totalMinutes) break;
    if (!topic.allDepsUnlocked) continue;

    // Session type: prefer practice when mastery is developed enough
    const sessionType: "lecture" | "practice" =
      profile.activePracticeRatio >= 0.5 && topic.masteryScore > 0.3
        ? "practice"
        : "lecture";

    // Block duration: capped at 90 min per topic, capped at remaining budget
    const baseDuration = Math.min(
      Math.round(Math.min(topic.estimatedHours * 60, 90)),
      totalMinutes - usedMinutes,
    );
    if (baseDuration < 15) continue;

    blocks.push({
      topicId: topic.id,
      topicName: topic.name,
      subject: topic.subject,
      sessionType,
      durationMinutes: baseDuration,
      priorityScore: topic.priority,
      masteryScore: topic.masteryScore,
    });

    usedMinutes += baseDuration;
  }

  // ── Psychological reset heuristic ─────────────────────────────────────────
  // If every eligible topic is blocked (dependencies), the student is stuck.
  // Surface top available topics regardless, to maintain momentum.
  const isReset = blocks.length === 0 && scored.length > 0;
  if (isReset) {
    const resetTopics = scored.slice(0, 3);
    for (const topic of resetTopics) {
      if (usedMinutes >= totalMinutes) break;
      const dur = Math.min(60, totalMinutes - usedMinutes);
      if (dur < 15) break;
      blocks.push({
        topicId: topic.id,
        topicName: topic.name,
        subject: topic.subject,
        sessionType: "lecture",
        durationMinutes: dur,
        priorityScore: topic.priority,
        masteryScore: topic.masteryScore,
      });
      usedMinutes += dur;
    }
  }

  // ── Recompute priority scores on all topics ───────────────────────────────
  const updatedTopics = topics.map((t) => ({
    id: t.id,
    priorityScore: computePriority(t, daysToExam, newDiscipline),
  }));

  const schedule: LocalDailySchedule = {
    id: crypto.randomUUID(),
    date: targetDate,
    blocks,
    scheduledHours,
    daysUntilExam: daysToExam,
    isReset,
    computedBy: "nightly",
    computedAt: new Date().toISOString(),
  };

  return { schedule, updatedProfile, updatedTopics };
}

/**
 * Apply an online Bayesian mastery update after a practice session.
 *
 *   M(t+1) = M(t) + (1/N) × (score − M(t))
 *
 * where N = total tests taken and score is normalized to [0, 1].
 * Weighted by the session's quality weight so auto-tracked sessions
 * contribute more than manually logged ones.
 */
export function applyMasteryUpdate(
  currentMastery: number,
  testsCount: number,
  testScore: number,
  testScoreMax: number,
  qualityWeight = 1,
): { masteryAfter: number; confidenceAfter: number } {
  const normalized = testScore / Math.max(testScoreMax, 1);
  const nt = testsCount + 1;
  const alpha = qualityWeight / nt;
  const masteryAfter = Math.min(1, Math.max(0, currentMastery + alpha * (normalized - currentMastery)));
  // Confidence grows with practice attempts (Wilson-style): nt / (nt + 10)
  const confidenceAfter = nt / (nt + 10);
  return { masteryAfter, confidenceAfter };
}

/**
 * Compute the "study quality index" for a session, combining four signals:
 *   - Focus ratio (foreground time / total session time)
 *   - Interaction rate (interactions per focused minute, normalized 0–1)
 *   - Mastery gain per hour (normalized against expected gain rate)
 *   - Fragmentation penalty (many short segments vs. one long block)
 */
export function computeSessionQuality({
  focusRatio,
  interactionCount,
  focusedMinutes,
  masteryGainFraction = 0,
  segmentCount = 1,
}: {
  focusRatio: number;
  interactionCount: number;
  focusedMinutes: number;
  masteryGainFraction?: number;
  segmentCount?: number;
}): number {
  const interactionRate = focusedMinutes > 0
    ? Math.min(interactionCount / focusedMinutes, 1)
    : 0;
  // Fragmentation penalty: 1 segment = 1.0, each additional segment reduces score
  const fragmentationScore = Math.max(0, 1 - (segmentCount - 1) * 0.1);
  // Mastery gain contribution (normalized; expected ~5% per session)
  const masteryContrib = Math.min(masteryGainFraction / 0.05, 1);

  return Math.round(
    (focusRatio * 0.4 + interactionRate * 0.25 + masteryContrib * 0.2 + fragmentationScore * 0.15) * 100,
  ) / 100;
}

/**
 * Check whether confidence and mastery are diverging — two flags:
 *
 * "under-practiced": high mastery score, very low confidence (≤0.1)
 *   → student may have self-reported high mastery without doing the practice
 *
 * "practicing-wrong": high confidence (many attempts), low mastery
 *   → student is drilling but not learning — needs conceptual work first
 */
export function detectConfidenceMasteryDivergence(
  mastery: number,
  confidence: number,
): { type: "under-practiced" | "practicing-wrong" | null; message: string | null } {
  if (mastery >= 0.7 && confidence <= 0.1) {
    return {
      type: "under-practiced",
      message: `Mastery appears high (${Math.round(mastery * 100)}%) but you've barely attempted practice questions. Validate your understanding with test problems.`,
    };
  }
  if (confidence >= 0.6 && mastery < 0.4) {
    return {
      type: "practicing-wrong",
      message: `You've taken many practice attempts but mastery is low (${Math.round(mastery * 100)}%). Focus on understanding concepts before drilling.`,
    };
  }
  return { type: null, message: null };
}

/**
 * On-track predictor: given current average mastery, daily study hours,
 * and days remaining, estimate projected mastery at exam date.
 *
 * Returns required daily hours delta to reach the target mastery.
 */
export function predictTrajectory({
  currentMastery,
  weeklyStudiedHours,
  daysUntilExam,
  totalEstimatedHours,
  targetMastery = 0.8,
}: {
  currentMastery: number;
  weeklyStudiedHours: number;
  daysUntilExam: number;
  totalEstimatedHours: number;
  targetMastery?: number;
}): {
  projectedMastery: number;
  onTrack: boolean;
  requiredDailyHours: number;
  requiredDelta: number;
} {
  const dailyHours = weeklyStudiedHours / 7;
  const hoursRemaining = daysUntilExam * dailyHours;
  const masteryGainPerHour = totalEstimatedHours > 0 ? 0.7 / totalEstimatedHours : 0;
  const projectedMastery = Math.min(1, currentMastery + hoursRemaining * masteryGainPerHour);

  const hoursNeeded = totalEstimatedHours > 0
    ? Math.max(0, (targetMastery - currentMastery) / masteryGainPerHour)
    : 0;
  const requiredDailyHours = daysUntilExam > 0 ? hoursNeeded / daysUntilExam : 0;
  const requiredDelta = Math.max(0, requiredDailyHours - dailyHours);

  return {
    projectedMastery: Math.round(projectedMastery * 100) / 100,
    onTrack: projectedMastery >= targetMastery,
    requiredDailyHours: Math.round(requiredDailyHours * 10) / 10,
    requiredDelta: Math.round(requiredDelta * 10) / 10,
  };
}
