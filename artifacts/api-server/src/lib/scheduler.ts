import { db, topicsTable, studentProfileTable, studySessionsTable } from "@workspace/db";
import { desc, eq, gte } from "drizzle-orm";
import { logger } from "./logger";

export interface ScheduleBlock {
  topicId: number;
  topicName: string;
  subject: string;
  sessionType: "lecture" | "practice";
  durationMinutes: number;
  priorityScore: number;
  masteryScore: number;
  explanation: BlockExplanation;
}

function parseDeps(prerequisites: string): number[] {
  try {
    return JSON.parse(prerequisites) as number[];
  } catch {
    return [];
  }
}

const MIN_DECAY_STABILITY = 0.1;
const TOTAL_PREPARATION_HORIZON_DAYS = 730;
/** Recency suppression window: topics studied within this many hours are suppressed. */
const RECENT_STUDY_SUPPRESSION_HOURS = 48;
/** Strongest suppression floor applied at 0 h (very recently studied). */
const RECENT_STUDY_SUPPRESSION_FLOOR = 0.35;
/** Maximum bridge blocks allowed per day to prevent over-bridging. */
const MAX_BRIDGE_BLOCKS_PER_DAY = 3;
/**
 * Class-11 soft priority boost: max multiplier applied when no 11th topic
 * has been studied in this many days (smooth ramp up to this threshold).
 */
const ELEVENTH_EXPOSURE_BOOST_MAX = 1.6;
const ELEVENTH_EXPOSURE_BOOST_DAYS = 7;
const BEHAVIOR_LOOKBACK_DAYS = 21;
const BEHAVIOR_MIN_SESSIONS = 8;
const BEHAVIOR_STABILITY_MAX_BLEND = 0.45;
const CAPACITY_MAX_DOWNSHIFT = 0.35;
const CAPACITY_MAX_UPSHIFT = 0.15;
const MAX_SPLIT_BLOCKS_PER_DAY = 2;
const MIN_BLOCK_MINUTES = 15;

const DEFAULT_SLOT_PERFORMANCE = [1, 0.88, 0.75, 0.62] as const;

type AcademicClass = 11 | 12 | "unknown";
type PreparationPhase = "foundation" | "transition" | "consolidation";

interface PreparationPhaseState {
  phase: PreparationPhase;
  daysRemaining: number;
  journeyCompletedRatio: number;
}

/** Engagement snapshot derived from topic rows — used to hybridise phase inference. */
interface PhaseEngagementContext {
  /** How many class-12 topics have been studied at least once. */
  twelfthStudiedCount: number;
  /** Total class-12 topics in the syllabus. */
  twelfthTopicCount: number;
  /** Total topics studied at least once across all classes. */
  totalStudiedCount: number;
}

function daysSinceStudied(lastStudiedAt: Date | null): number {
  if (!lastStudiedAt) return 999;
  const diff = Date.now() - new Date(lastStudiedAt).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function hoursSinceStudied(lastStudiedAt: Date | null): number {
  if (!lastStudiedAt) return 9999;
  const diff = Date.now() - new Date(lastStudiedAt).getTime();
  return diff / (1000 * 60 * 60);
}

/**
 * Ebbinghaus-style retention: R = e^(-t/S)
 * Stability S scales with mastery: mastery=0 → S=3d, mastery=1 → S=21d.
 */
function forgettingRetention(mastery: number, days: number, decayConstant = 1): number {
  const stability = 3 + mastery * 18;
  return Math.exp((-days / Math.max(stability, MIN_DECAY_STABILITY)) * decayConstant);
}

export type SchedulerMode = "adaptive" | "static" | "random";

export interface SchedulerTuning {
  decayConstant: number;
  capacitySmoothing: number;
  growthRateMultiplier: number;
}

export interface BlockExplanation {
  priorityContribution: {
    weightage: number;
    difficulty: number;
    lowMastery: number;
    total: number;
  };
  dependencyTriggers: {
    prerequisites: number[];
    unlockedDownstreamTopics: number;
    pressure: number;
  };
  decayPressure: {
    daysSinceStudied: number;
    retention: number;
    pressure: number;
  };
  activePracticeImbalance: {
    targetRatio: number;
    currentRatio: number;
    pressure: number;
  };
  recentPerformanceSignal: {
    confidence: number;
    pressure: number;
  };
  temporalRelevance: {
    phase: PreparationPhase;
    journeyCompletedRatio: number;
    daysRemaining: number;
    topicClass: AcademicClass;
    temporalWeight: number;
  };
  recencySuppression: {
    hoursSinceStudied: number;
    multiplier: number;
    suppressed: boolean;
  };
}

const TARGET_ACTIVE_PRACTICE_RATIO = 0.5;
// Imbalance pressure starts when practice ratio falls below this floor.
const LOW_PRACTICE_RATIO_THRESHOLD = 0.35;

export interface PlannerRiskSignal {
  backlogRisk: number;
  fallingBehind: boolean;
  intervention: "none" | "reduced_targets" | "priority_concentration" | "early_reset";
}

export interface PlannerOutput {
  date: string;
  scheduledHours: number;
  blocks: ScheduleBlock[];
  daysUntilExam: number;
  isReset: boolean;
  riskSignal: PlannerRiskSignal;
}

type TopicRow = typeof topicsTable.$inferSelect;
type ProfileRow = typeof studentProfileTable.$inferSelect;

interface PriorityBreakdown {
  priority: number;
  explainability: BlockExplanation;
  retention: number;
}

interface TopicBehaviorSignal {
  struggleScore: number;
  reduceBlockFactor: number;
  splitRecommended: boolean;
  alternateSessionType: "lecture" | "practice" | null;
}

interface BehavioralContext {
  reliability: number;
  effectiveCapacityFactor: number;
  preferredHighDemandProgress: number;
  slotPerformance: [number, number, number, number];
  hasPersonalizedEnergyModel: boolean;
  topicSignals: Map<number, TopicBehaviorSignal>;
  preExamTransition: number;
}

function defaultBehavioralContext(daysUntilExamValue: number): BehavioralContext {
  return {
    reliability: 0,
    effectiveCapacityFactor: 1,
    preferredHighDemandProgress: 0.15,
    slotPerformance: [...DEFAULT_SLOT_PERFORMANCE] as [number, number, number, number],
    hasPersonalizedEnergyModel: false,
    topicSignals: new Map<number, TopicBehaviorSignal>(),
    preExamTransition: smoothstep(150, 14, daysUntilExamValue),
  };
}

function qualityFromSession(
  session: typeof studySessionsTable.$inferSelect,
): number {
  const normalizedScore =
    session.testScore !== null && session.testScoreMax !== null
      ? clamp(session.testScore / Math.max(session.testScoreMax, 1), 0, 1)
      : null;
  const focusQuality = clamp(
    1 - (session.distractionMinutes ?? 0) / Math.max(session.durationMinutes, 1),
    0,
    1,
  );
  const durationQuality = clamp(session.durationMinutes / 45, 0.4, 1);
  if (normalizedScore === null) {
    return clamp(focusQuality * 0.75 + durationQuality * 0.25, 0, 1);
  }
  return clamp(
    normalizedScore * 0.6 + focusQuality * 0.25 + durationQuality * 0.15,
    0,
    1,
  );
}

function deriveBehavioralContext(params: {
  profile: ProfileRow;
  topics: TopicRow[];
  sessions: Array<typeof studySessionsTable.$inferSelect>;
  daysUntilExamValue: number;
}): BehavioralContext {
  const base = defaultBehavioralContext(params.daysUntilExamValue);
  if (params.sessions.length === 0) return base;

  const reliability = smoothstep(BEHAVIOR_MIN_SESSIONS, 30, params.sessions.length);
  const effectiveBlend = Math.min(BEHAVIOR_STABILITY_MAX_BLEND, reliability);
  const recentWindowDays = BEHAVIOR_LOOKBACK_DAYS;

  let totalMinutes = 0;
  let effectiveMinutes = 0;
  const slotMinutes = [0, 0, 0, 0];
  const slotQualityMinutes = [0, 0, 0, 0];
  const topicAccumulator = new Map<
    number,
    { lowRating: number; partial: number; lectureCount: number; practiceCount: number }
  >();

  for (const session of params.sessions) {
    const quality = qualityFromSession(session);
    totalMinutes += session.durationMinutes;
    effectiveMinutes += session.durationMinutes * quality;

    const hour = new Date(session.studiedAt).getHours();
    const slot = hour < 12 ? 0 : hour < 17 ? 1 : hour < 21 ? 2 : 3;
    slotMinutes[slot] += session.durationMinutes;
    slotQualityMinutes[slot] += session.durationMinutes * quality;

    const current = topicAccumulator.get(session.topicId) ?? {
      lowRating: 0,
      partial: 0,
      lectureCount: 0,
      practiceCount: 0,
    };
    const normalizedScore =
      session.testScore !== null && session.testScoreMax !== null
        ? session.testScore / Math.max(session.testScoreMax, 1)
        : null;
    const distractionRatio = (session.distractionMinutes ?? 0) / Math.max(session.durationMinutes, 1);
    if (normalizedScore !== null && normalizedScore < 0.55) {
      current.lowRating += 1;
    }
    if (distractionRatio > 0.35 || session.durationMinutes < 20) {
      current.partial += 1;
    }
    if (session.sessionType === "practice") current.practiceCount += 1;
    else current.lectureCount += 1;
    topicAccumulator.set(session.topicId, current);
  }

  const dailyActualHours = totalMinutes / 60 / recentWindowDays;
  const disciplineFactor = clamp(
    totalMinutes > 0 ? effectiveMinutes / totalMinutes : params.profile.disciplineScore,
    0.45,
    1.05,
  );
  const dailyEffectiveHours = dailyActualHours * disciplineFactor;
  const nominalCapacity = Math.max(geometricCapacity(params.profile.capacityScore, params.profile.disciplineScore), 0.1);
  const rawCapacityFactor = clamp(dailyEffectiveHours / nominalCapacity, 0.6, 1.1);
  const effectiveCapacityFactor = clamp(
    1 + (rawCapacityFactor - 1) * effectiveBlend,
    1 - CAPACITY_MAX_DOWNSHIFT,
    1 + CAPACITY_MAX_UPSHIFT,
  );

  const slotPerformanceRaw = slotMinutes.map((minutes, index) =>
    minutes > 0 ? slotQualityMinutes[index] / minutes : DEFAULT_SLOT_PERFORMANCE[index],
  );
  const slotMean = slotPerformanceRaw.reduce((sum, value) => sum + value, 0) / slotPerformanceRaw.length;
  const slotPerformance = slotPerformanceRaw.map((value) =>
    clamp(value / Math.max(slotMean, 0.01), 0.7, 1.25),
  ) as [number, number, number, number];

  const weightedSlotCenter = slotPerformance.reduce((sum, value, index) => sum + value * index, 0) /
    Math.max(slotPerformance.reduce((sum, value) => sum + value, 0), 0.01);
  const preferredProgress = clamp(weightedSlotCenter / 3, 0, 1);
  const hasPersonalizedEnergyModel = reliability >= 0.25 && slotMinutes.filter((minutes) => minutes >= 45).length >= 2;
  const preferredHighDemandProgress = hasPersonalizedEnergyModel
    ? clamp(0.7 * preferredProgress + 0.3 * base.preferredHighDemandProgress, 0, 1)
    : base.preferredHighDemandProgress;

  const topicSignals = new Map<number, TopicBehaviorSignal>();
  for (const [topicId, stats] of topicAccumulator.entries()) {
    const struggleEvents = stats.lowRating + stats.partial;
    if (struggleEvents < 2) continue;
    const struggleScore = clamp(struggleEvents / 4, 0, 1);
    const reduceBlockFactor = clamp(1 - 0.35 * struggleScore * effectiveBlend, 0.6, 1);
    const dominantType =
      stats.practiceCount === stats.lectureCount
        ? null
        : stats.practiceCount > stats.lectureCount
          ? "practice"
          : "lecture";
    topicSignals.set(topicId, {
      struggleScore: Math.round(struggleScore * 1000) / 1000,
      reduceBlockFactor,
      splitRecommended: struggleScore >= 0.5 && reliability >= 0.25,
      alternateSessionType:
        dominantType === null
          ? null
          : dominantType === "practice"
            ? "lecture"
            : "practice",
    });
  }

  return {
    reliability,
    effectiveCapacityFactor,
    preferredHighDemandProgress,
    slotPerformance,
    hasPersonalizedEnergyModel,
    topicSignals,
    preExamTransition: base.preExamTransition,
  };
}

/**
 * Deterministic hash used to rank topics in random mode.
 * This makes random mode reproducible for the same day/topic seed.
 */
function deterministicHash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 2 ** 32;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Ken Perlin's smoothstep: returns 0 at x≤edge0, 1 at x≥edge1, smooth cubic in between.
 * Works for both ascending (edge0 < edge1) and descending (edge0 > edge1) mappings.
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function classifyTopicClass(topic: TopicRow): AcademicClass {
  const text = `${topic.name} ${topic.subject}`.toLowerCase();
  const class11Pattern = /\b(11|11th|xi|class\s*11|grade\s*11|std\s*11)\b/;
  const class12Pattern = /\b(12|12th|xii|class\s*12|grade\s*12|std\s*12)\b/;
  if (class12Pattern.test(text)) return 12;
  if (class11Pattern.test(text)) return 11;
  return "unknown";
}

function inferPreparationPhase(daysUntilExam: number, engagement?: PhaseEngagementContext): PreparationPhaseState {
  const daysRemaining = Math.max(daysUntilExam, 0);
  const elapsedDays = clamp(TOTAL_PREPARATION_HORIZON_DAYS - daysRemaining, 0, TOTAL_PREPARATION_HORIZON_DAYS);
  let journeyCompletedRatio = elapsedDays / TOTAL_PREPARATION_HORIZON_DAYS;

  // Hybrid adjustment: if 12th-class engagement has started, nudge the journey
  // ratio forward so phase reflects actual preparation stage.
  // Uses a smooth S-curve over the full [0, 1] engagement range — no threshold jump.
  if (engagement && engagement.totalStudiedCount >= 3 && engagement.twelfthTopicCount > 0) {
    const twelfthEngagementRatio = engagement.twelfthStudiedCount / engagement.twelfthTopicCount;
    // smoothstep(0, 1, ratio) starts near 0 for very low engagement and reaches 1 at full engagement.
    const nudge = 0.15 * smoothstep(0, 1, twelfthEngagementRatio);
    journeyCompletedRatio = clamp(journeyCompletedRatio + nudge, 0, 1);
  }

  if (journeyCompletedRatio >= 0.72 || daysRemaining <= 210) {
    return { phase: "consolidation", daysRemaining, journeyCompletedRatio };
  }
  if (journeyCompletedRatio >= 0.38 || daysRemaining <= 430) {
    return { phase: "transition", daysRemaining, journeyCompletedRatio };
  }
  return { phase: "foundation", daysRemaining, journeyCompletedRatio };
}

function computeTemporalWeight(params: {
  topicClass: AcademicClass;
  phaseState: PreparationPhaseState;
  masteryScore: number;
  retention: number;
  unlocksTwelfthTopics: number;
}): number {
  const latePressure = clamp((params.phaseState.journeyCompletedRatio - 0.45) / 0.45, 0, 1);
  if (params.topicClass === 12) {
    return 1 + 0.85 * latePressure;
  }
  if (params.topicClass === 11) {
    let weight = 1 - 0.6 * latePressure;
    // Smooth transitions: use smoothstep to avoid abrupt jumps at fixed mastery/retention thresholds.
    // lowMasteryException: peaks at 0.35 for mastery=0, fades smoothly to 0 at mastery=0.55.
    const lowMasteryException = 0.35 * smoothstep(0.55, 0, params.masteryScore);
    // decayException: peaks at 0.20 for retention=0, fades smoothly to 0 at retention=0.60.
    const decayException = 0.20 * smoothstep(0.60, 0, params.retention);
    const prerequisiteException = params.unlocksTwelfthTopics > 0 ? Math.min(0.25, params.unlocksTwelfthTopics * 0.08) : 0;
    weight += lowMasteryException + decayException + prerequisiteException;
    return clamp(weight, 0.3, 1.15);
  }
  return 1;
}

/**
 * Returns the dynamic 12th-class scheduling target share for the current day.
 * Follows a smooth polynomial curve from 0.60 (early consolidation) to 0.90 (near exam).
 * Both `target` and `minimum` values are returned to allow the caller to enforce a soft range.
 */
function computeTwelfthTargetShare(daysRemaining: number): { target: number; minimum: number } {
  // x: 0 at 600+ days, 1 at 0 days remaining
  const x = clamp(1 - daysRemaining / 600, 0, 1);
  const target = clamp(0.60 + 0.30 * Math.pow(x, 1.2), 0.60, 0.90);
  const minimum = clamp(target - 0.10, 0.50, 0.80);
  return { target, minimum };
}

/**
 * Returns an adaptive bridge-revision block duration in minutes.
 * Low mastery or high difficulty → longer revision (up to 30m).
 * High mastery + easy topic → short (5–10m).
 */
function computeBridgeMinutes(prereq: TopicRow): number {
  const masteryPenalty = clamp(1 - prereq.masteryScore, 0, 1);
  const difficultyFactor = clamp(prereq.difficultyLevel / 5, 0.2, 1.0);
  // Base 5m + up to 25m scaled by mastery gap and difficulty
  const raw = 5 + 25 * masteryPenalty * (0.6 + 0.4 * difficultyFactor);
  // Round to nearest 5m, clamp to [5, 30]
  return Math.round(clamp(raw, 5, 30) / 5) * 5;
}

/**
 * Smooth time-decayed recency multiplier for priority suppression.
 *   0 – 6 h  : strong suppression  (multiplier near FLOOR = 0.35)
 *   6 – 24 h : moderate            (ramps from ~0.38 toward ~0.68)
 *   24 – 48 h: light               (ramps from ~0.68 toward 1.0)
 * Uses a cubic smoothstep so there are no step discontinuities.
 * Returns 1.0 when suppression should be bypassed (retention risk or beyond window).
 */
function computeRecencyMultiplier(hoursStudied: number, needsSpacedRepetition: boolean): number {
  if (needsSpacedRepetition || hoursStudied >= RECENT_STUDY_SUPPRESSION_HOURS) return 1;
  const t = clamp(hoursStudied / RECENT_STUDY_SUPPRESSION_HOURS, 0, 1);
  // Cubic ease-in (smoothstep): slow recovery early, faster at end.
  const recovery = t * t * (3 - 2 * t);
  return clamp(RECENT_STUDY_SUPPRESSION_FLOOR + (1 - RECENT_STUDY_SUPPRESSION_FLOOR) * recovery, RECENT_STUDY_SUPPRESSION_FLOOR, 1);
}

function computeMasteryVariance(masteryValues: number[]): { variance: number; allZero: boolean } {
  if (masteryValues.length === 0) {
    return { variance: 0, allZero: true };
  }
  const mean = masteryValues.reduce((sum, value) => sum + value, 0) / masteryValues.length;
  const variance = masteryValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / masteryValues.length;
  const allZero = masteryValues.every((value) => value === 0);
  return { variance: Math.round(variance * 1000) / 1000, allZero };
}

function buildAdjacency(topics: TopicRow[]): Map<number, number[]> {
  const graph = new Map<number, number[]>();
  for (const topic of topics) {
    graph.set(topic.id, []);
  }
  for (const topic of topics) {
    const deps = parseDeps(topic.prerequisites);
    for (const dep of deps) {
      const list = graph.get(dep) ?? [];
      list.push(topic.id);
      graph.set(dep, list);
    }
  }
  return graph;
}

function countUnlockedDownstream(topicId: number, graph: Map<number, number[]>): number {
  const queue = [...(graph.get(topicId) ?? [])];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of graph.get(current) ?? []) {
      if (!visited.has(next)) {
        queue.push(next);
      }
    }
  }
  return visited.size;
}

function computePriorityBreakdown(
  topic: TopicRow,
  profile: ProfileRow,
  daysUntilExam: number,
  tuning: SchedulerTuning,
  graph: Map<number, number[]>,
  topicClasses: Map<number, AcademicClass>,
  phaseState: PreparationPhaseState,
  eleventhExposureBoost: number,
  behavioral: BehavioralContext,
): PriorityBreakdown {
  const daysDormant = daysSinceStudied(topic.lastStudiedAt);
  const retention = forgettingRetention(topic.masteryScore, daysDormant, tuning.decayConstant);
  // Effective mastery is modeled as mastery attenuated by retention (m * R).
  // Priority pressure then uses the complementary gap: 1 - effectiveMastery.
  const lowMastery = clamp(1 - topic.masteryScore * retention, 0, 1);
  const urgency = daysUntilExam > 0 ? 1 / daysUntilExam : 1;
  const weightage = clamp(topic.estimatedHours * urgency, 0, 10);
  const difficulty = clamp(topic.difficultyLevel / 5, 0.2, 1);
  const unlockedDownstreamTopics = countUnlockedDownstream(topic.id, graph);
  const dependencyPressure = clamp(unlockedDownstreamTopics / 5, 0, 1);
  const decayPressure = clamp(1 - retention, 0, 1);
  const practicePressure = clamp(
    profile.activePracticeRatio < LOW_PRACTICE_RATIO_THRESHOLD
      ? (LOW_PRACTICE_RATIO_THRESHOLD - profile.activePracticeRatio) / LOW_PRACTICE_RATIO_THRESHOLD
      : 0,
    0,
    1,
  );
  const performancePressure = clamp(1 - topic.confidenceScore, 0, 1);
  const disciplineMod = 1 / Math.max(profile.disciplineScore, 0.1);
  const topicClass = topicClasses.get(topic.id) ?? "unknown";
  const unlockedDownstreamTwelfthTopics = (graph.get(topic.id) ?? []).filter(
    (childId) => topicClasses.get(childId) === 12,
  ).length;
  const temporalWeight = computeTemporalWeight({
    topicClass,
    phaseState,
    masteryScore: topic.masteryScore,
    retention,
    unlocksTwelfthTopics: unlockedDownstreamTwelfthTopics,
  });

  // Recent-study suppression: reduce priority for topics studied in the last 48h
  // unless they are at risk of forgetting (spaced-repetition window).
  const hoursStudied = hoursSinceStudied(topic.lastStudiedAt);
  const needsSpacedRepetition = retention < 0.45;
  const recencyMultiplier = computeRecencyMultiplier(hoursStudied, needsSpacedRepetition);
  const hasHistory = topic.lastStudiedAt !== null || topic.testsCount > 0;
  const preExamWeight = clamp(
    hasHistory
      ? 1 + 0.22 * behavioral.preExamTransition
      : 1 - 0.35 * behavioral.preExamTransition,
    0.6,
    1.25,
  );

  const overconfidenceSignal =
    smoothstep(0.15, 0.55, topic.confidenceScore - topic.masteryScore) *
    smoothstep(0.65, 0.25, topic.masteryScore);
  const underconfidenceSignal =
    smoothstep(0.15, 0.55, topic.masteryScore - topic.confidenceScore) *
    smoothstep(0.55, 0.95, topic.masteryScore);
  const divergenceMultiplier = clamp(
    1 + 0.35 * overconfidenceSignal - 0.25 * underconfidenceSignal,
    0.75,
    1.35,
  );

  const struggleSignal = behavioral.topicSignals.get(topic.id);
  const struggleMultiplier = struggleSignal
    ? clamp(1 + 0.2 * struggleSignal.struggleScore * behavioral.reliability, 1, 1.2)
    : 1;

  // Proactive 11th maintenance: soft boost for class-11 topics when recent exposure is sparse.
  const topicClassForBoost = topicClasses.get(topic.id) ?? "unknown";
  const exposureBoost = topicClassForBoost === 11 ? eleventhExposureBoost : 1;

  const total = (
    weightage * 0.3 +
    difficulty * 0.2 +
    lowMastery * 0.35 +
    dependencyPressure * 0.1 +
    decayPressure * 0.05
  ) * disciplineMod * temporalWeight * recencyMultiplier * exposureBoost * divergenceMultiplier * preExamWeight * struggleMultiplier;

  return {
    priority: total,
    explainability: {
      priorityContribution: {
        weightage: Math.round(weightage * 1000) / 1000,
        difficulty: Math.round(difficulty * 1000) / 1000,
        lowMastery: Math.round(lowMastery * 1000) / 1000,
        total: Math.round(total * 1000) / 1000,
      },
      dependencyTriggers: {
        prerequisites: parseDeps(topic.prerequisites),
        unlockedDownstreamTopics,
        pressure: Math.round(dependencyPressure * 1000) / 1000,
      },
      decayPressure: {
        daysSinceStudied: daysDormant,
        retention: Math.round(retention * 1000) / 1000,
        pressure: Math.round(decayPressure * 1000) / 1000,
      },
      activePracticeImbalance: {
        targetRatio: TARGET_ACTIVE_PRACTICE_RATIO,
        currentRatio: Math.round(profile.activePracticeRatio * 1000) / 1000,
        pressure: Math.round(practicePressure * 1000) / 1000,
      },
      recentPerformanceSignal: {
        confidence: Math.round(topic.confidenceScore * 1000) / 1000,
        pressure: Math.round(performancePressure * 1000) / 1000,
      },
      temporalRelevance: {
        phase: phaseState.phase,
        journeyCompletedRatio: Math.round(phaseState.journeyCompletedRatio * 1000) / 1000,
        daysRemaining: phaseState.daysRemaining,
        topicClass,
        temporalWeight: Math.round(temporalWeight * 1000) / 1000,
      },
      recencySuppression: {
        hoursSinceStudied: Math.round(hoursStudied * 10) / 10,
        multiplier: Math.round(recencyMultiplier * 1000) / 1000,
        suppressed: recencyMultiplier < 1,
      },
    },
    retention,
  };
}

function daysUntil(examDate: string): number {
  const now = new Date();
  const exam = new Date(examDate);
  const diff = exam.getTime() - now.getTime();
  return Math.max(Math.ceil(diff / (1000 * 60 * 60 * 24)), 0);
}

function geometricCapacity(baseCapacity: number, disciplineScore: number): number {
  return baseCapacity * (0.6 + 0.4 * disciplineScore);
}

function interventionFromRisk(backlogRisk: number): PlannerRiskSignal["intervention"] {
  if (backlogRisk >= 0.85) return "early_reset";
  if (backlogRisk >= 0.7) return "priority_concentration";
  if (backlogRisk >= 0.5) return "reduced_targets";
  return "none";
}

function scoreBacklogRisk(
  profile: ProfileRow,
  daysUntilExamValue: number,
  openTopicCount: number,
): PlannerRiskSignal {
  const timePressure = daysUntilExamValue <= 0 ? 1 : clamp(1 - daysUntilExamValue / 120, 0, 1);
  const disciplineDrag = clamp(1 - profile.disciplineScore, 0, 1);
  const lowCapacity = clamp((2.5 - profile.capacityScore) / 2.5, 0, 1);
  const breadthPressure = clamp(openTopicCount / 40, 0, 1);
  const backlogRisk = clamp(
    timePressure * 0.35 + disciplineDrag * 0.35 + lowCapacity * 0.2 + breadthPressure * 0.1,
    0,
    1,
  );
  const intervention = interventionFromRisk(backlogRisk);
  return {
    backlogRisk: Math.round(backlogRisk * 1000) / 1000,
    fallingBehind: backlogRisk >= 0.5,
    intervention,
  };
}

function isLatePhaseEleventhException(row: { topic: TopicRow; retention: number; topicClass: AcademicClass }): boolean {
  if (row.topicClass !== 11) return true;
  const lowMastery = row.topic.masteryScore < 0.4;
  const decayed = row.retention < 0.45;
  // High-difficulty topics with imperfect mastery are also retained as support content.
  const highRisk = row.topic.difficultyLevel >= 4 && row.topic.masteryScore < 0.65;
  return lowMastery || decayed || highRisk;
}

function chooseSessionType(
  profile: ProfileRow,
  topic: TopicRow,
  daysUntilExam: number,
  phase: PreparationPhase,
  behavioral: BehavioralContext,
): "lecture" | "practice" {
  const examPracticeBias = clamp(1 - daysUntilExam / 220, 0, 1);
  const preExamBias = clamp(examPracticeBias * 0.6 + behavioral.preExamTransition * 0.4, 0, 1);
  const blendedPracticeBias = profile.activePracticeRatio * 0.6 + examPracticeBias * 0.4;
  const overconfidenceSignal =
    smoothstep(0.15, 0.55, topic.confidenceScore - topic.masteryScore) *
    smoothstep(0.65, 0.25, topic.masteryScore);
  const underconfidenceSignal =
    smoothstep(0.15, 0.55, topic.masteryScore - topic.confidenceScore) *
    smoothstep(0.55, 0.95, topic.masteryScore);
  if (overconfidenceSignal > 0.35) {
    return "practice";
  }
  if (underconfidenceSignal > 0.45) {
    return "lecture";
  }
  const topicSignal = behavioral.topicSignals.get(topic.id);
  if (topicSignal?.alternateSessionType && topicSignal.struggleScore >= 0.5) {
    return topicSignal.alternateSessionType;
  }
  if (phase === "consolidation" && topic.masteryScore >= 0.5) {
    return "practice";
  }
  return (blendedPracticeBias * 0.7 + preExamBias * 0.3) >= 0.45 && topic.masteryScore > 0.25 ? "practice" : "lecture";
}

function baseBlockMinutes(
  topic: TopicRow,
  remainingMinutes: number,
  phase: PreparationPhase,
): number {
  const phaseCap = phase === "consolidation" ? 60 : 90;
  const raw = Math.round(Math.min(topic.estimatedHours * 60, phaseCap));
  const adjusted = phase === "consolidation" && topic.masteryScore < 0.3
    ? Math.min(raw, 45)
    : raw;
  return Math.min(adjusted, remainingMinutes);
}

export function buildSchedulePlan(params: {
  profile: ProfileRow;
  topics: TopicRow[];
  mode: SchedulerMode;
  dateSeed: string;
  staticTopicOrder?: number[];
  tuning?: SchedulerTuning;
  forceIntervention?: PlannerRiskSignal["intervention"] | null;
  behavioralContext?: BehavioralContext;
}): PlannerOutput {
  const tuning = params.tuning ?? {
    decayConstant: 1,
    capacitySmoothing: 0.8,
    growthRateMultiplier: 1,
  };
  const profile = params.profile;
  const topics = params.topics;
  const masteryStats = computeMasteryVariance(topics.map((topic) => topic.masteryScore));
  // Warning-only here: route-level integrity guard performs automatic resets.
  // This check keeps scheduler calls observable even when invoked independently.
  if (masteryStats.variance === 0 && !masteryStats.allZero) {
    logger.warn(
      { topicCount: topics.length, variance: masteryStats.variance },
      "Scheduler input anomaly: mastery variance is zero for a non-zero state",
    );
  }
  const openTopics = topics.filter((t) => !t.isCompleted);
  const days = daysUntil(profile.examDate);
  const behavioral = params.behavioralContext ?? defaultBehavioralContext(days);

  // Build engagement context for hybrid phase inference from topic state.
  const topicClassesEarly = new Map<number, AcademicClass>(
    topics.map((topic) => [topic.id, classifyTopicClass(topic)]),
  );
  const engagement: PhaseEngagementContext = {
    twelfthStudiedCount: topics.filter(
      (t) => topicClassesEarly.get(t.id) === 12 && t.lastStudiedAt !== null,
    ).length,
    twelfthTopicCount: topics.filter((t) => topicClassesEarly.get(t.id) === 12).length,
    totalStudiedCount: topics.filter((t) => t.lastStudiedAt !== null).length,
  };
  const phaseState = inferPreparationPhase(days, engagement);
  const riskSignal = scoreBacklogRisk(profile, days, openTopics.length);
  const selectedIntervention = params.forceIntervention ?? riskSignal.intervention;

  // Proactive 11th maintenance: compute a smooth priority boost that rises as class-11
  // exposure becomes sparse (measured by days since the most recently studied 11th topic).
  // Uses smoothstep from 1.0 (studied within last ~1 day) to ELEVENTH_EXPOSURE_BOOST_MAX
  // (not studied in ELEVENTH_EXPOSURE_BOOST_DAYS days). Avoids forced injection.
  const class11Topics = topics.filter((t) => topicClassesEarly.get(t.id) === 11);
  const daysSinceLast11thStudy = class11Topics.length > 0
    ? Math.min(...class11Topics.map((t) => daysSinceStudied(t.lastStudiedAt)))
    : ELEVENTH_EXPOSURE_BOOST_DAYS;
  const eleventhExposureBoost = 1 + (ELEVENTH_EXPOSURE_BOOST_MAX - 1) *
    smoothstep(1, ELEVENTH_EXPOSURE_BOOST_DAYS, daysSinceLast11thStudy);

  const baseHours =
    geometricCapacity(profile.capacityScore, profile.disciplineScore) *
    tuning.growthRateMultiplier *
    behavioral.effectiveCapacityFactor;
  let scheduledHours = Math.max(0, baseHours);
  let isReset = false;

  if (selectedIntervention === "reduced_targets") {
    scheduledHours *= 0.85;
  } else if (selectedIntervention === "early_reset") {
    scheduledHours = Math.max(1.5, scheduledHours * 0.75);
    isReset = true;
  }

  const totalMinutes = Math.round(scheduledHours * 60);
  const graph = buildAdjacency(topics);
  const topicsById = new Map<number, TopicRow>(topics.map((topic) => [topic.id, topic]));
  const topicClasses = topicClassesEarly;

  const staticOrderIndex = new Map<number, number>(
    (params.staticTopicOrder ?? []).map((topicId, index) => [topicId, index]),
  );

  const scored = openTopics.map((topic) => {
    const deps = parseDeps(topic.prerequisites);
    const incompleteDeps = deps.filter((depId) => {
      const dep = topicsById.get(depId);
      return dep ? !(dep.masteryScore >= 0.6 || dep.isCompleted) : false;
    });
    const topicClass = topicClasses.get(topic.id) ?? "unknown";
    const canProceedWithBridge =
      phaseState.phase === "consolidation" &&
      topicClass === 12 &&
      incompleteDeps.some((depId) => topicClasses.get(depId) === 11);
    const allDepsComplete = incompleteDeps.length === 0;

    const adaptive = computePriorityBreakdown(
      topic,
      profile,
      days,
      tuning,
      graph,
      topicClasses,
      phaseState,
      eleventhExposureBoost,
      behavioral,
    );
    const randomPriority = deterministicHash(`${params.dateSeed}:${topic.id}`);
    const staticRank = staticOrderIndex.get(topic.id);
    const staticPriority = staticRank !== undefined
      ? 1 / (1 + staticRank)
      : 0;

    let modePriority = adaptive.priority;
    if (params.mode === "random") {
      modePriority = randomPriority;
    } else if (params.mode === "static") {
      modePriority = staticPriority;
    }

    return {
      topic,
      deps,
      topicClass,
      incompleteDeps,
      eligible: allDepsComplete || canProceedWithBridge,
      priority: allDepsComplete || canProceedWithBridge ? modePriority : 0,
      explainability: adaptive.explainability,
      retention: adaptive.retention,
    };
  });

  scored.sort((a, b) => b.priority - a.priority);

  let ranked = scored.filter((s) => s.eligible);
  if (selectedIntervention === "priority_concentration" || selectedIntervention === "early_reset") {
    ranked = ranked.slice(0, Math.max(2, Math.ceil(ranked.length * 0.35)));
  }

  const blocks: ScheduleBlock[] = [];
  let usedMinutes = 0;
  let twelfthMinutes = 0;
  const bridgedTopicIds = new Set<number>();
  let bridgeBlockCount = 0;
  let splitBlockCount = 0;

  const pickBridgePrerequisite = (row: typeof ranked[number]): TopicRow | null => {
    if (row.topicClass !== 12 || row.deps.length === 0) return null;
    const candidates = row.deps
      .map((depId) => topicsById.get(depId))
      .filter((dep): dep is TopicRow => Boolean(dep) && (topicClasses.get(dep!.id) === 11))
      .filter((dep) => !bridgedTopicIds.has(dep.id))
      .filter((dep) => dep.masteryScore < 0.75 || daysSinceStudied(dep.lastStudiedAt) >= 10 || !dep.isCompleted);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const aRisk = (1 - a.masteryScore) + Math.min(daysSinceStudied(a.lastStudiedAt) / 30, 1);
      const bRisk = (1 - b.masteryScore) + Math.min(daysSinceStudied(b.lastStudiedAt) / 30, 1);
      return bRisk - aRisk;
    });
    return candidates[0] ?? null;
  };

  const pushBlock = (row: typeof ranked[number]): void => {
    if (usedMinutes >= totalMinutes) return;

    const remainingBefore = totalMinutes - usedMinutes;
    const bridgePrerequisite = pickBridgePrerequisite(row);
    // Bridge injection control: cap total bridge blocks and avoid consecutive bridges.
    const lastBlockIsBridge = blocks.length > 0 && blocks[blocks.length - 1]!.topicName.endsWith("(Bridge revision)");
    if (bridgePrerequisite && bridgeBlockCount < MAX_BRIDGE_BLOCKS_PER_DAY && !lastBlockIsBridge) {
      const bridgeMinutes = computeBridgeMinutes(bridgePrerequisite);
      if (remainingBefore >= bridgeMinutes + 15) {
        blocks.push({
          topicId: bridgePrerequisite.id,
          topicName: `${bridgePrerequisite.name} (Bridge revision)`,
          subject: bridgePrerequisite.subject,
          sessionType: "lecture",
          durationMinutes: bridgeMinutes,
          priorityScore: Math.round(row.priority * 1000) / 1000,
          masteryScore: bridgePrerequisite.masteryScore,
          explanation: row.explainability,
        });
        usedMinutes += bridgeMinutes;
        bridgedTopicIds.add(bridgePrerequisite.id);
        bridgeBlockCount++;
      }
    }

    const remaining = totalMinutes - usedMinutes;
    const behaviorSignal = behavioral.topicSignals.get(row.topic.id);
    const rawMinutes = baseBlockMinutes(row.topic, remaining, phaseState.phase);
    const reducedMinutes = behaviorSignal
      ? Math.round(rawMinutes * behaviorSignal.reduceBlockFactor / 5) * 5
      : rawMinutes;
    const minutes = Math.min(Math.max(reducedMinutes, MIN_BLOCK_MINUTES), remaining);
    if (minutes < MIN_BLOCK_MINUTES) return;
    const sessionType = chooseSessionType(profile, row.topic, days, phaseState.phase, behavioral);
    blocks.push({
      topicId: row.topic.id,
      topicName: row.topic.name,
      subject: row.topic.subject,
      sessionType,
      durationMinutes: minutes,
      priorityScore: Math.round(row.priority * 1000) / 1000,
      masteryScore: row.topic.masteryScore,
      explanation: row.explainability,
    });
    usedMinutes += minutes;
    if (row.topicClass === 12) {
      twelfthMinutes += minutes;
    }

    const remainingAfter = totalMinutes - usedMinutes;
    if (
      behaviorSignal?.splitRecommended &&
      splitBlockCount < MAX_SPLIT_BLOCKS_PER_DAY &&
      remainingAfter >= MIN_BLOCK_MINUTES
    ) {
      const splitMinutes = Math.max(
        MIN_BLOCK_MINUTES,
        Math.min(20, Math.round(Math.max(minutes * 0.45, MIN_BLOCK_MINUTES) / 5) * 5, remainingAfter),
      );
      const splitType = behaviorSignal.alternateSessionType
        ? behaviorSignal.alternateSessionType
        : sessionType === "lecture"
          ? "practice"
          : "lecture";
      blocks.push({
        topicId: row.topic.id,
        topicName: `${row.topic.name} (Focused reinforcement)`,
        subject: row.topic.subject,
        sessionType: splitType,
        durationMinutes: splitMinutes,
        priorityScore: Math.round(row.priority * 1000) / 1000,
        masteryScore: row.topic.masteryScore,
        explanation: row.explainability,
      });
      usedMinutes += splitMinutes;
      if (row.topicClass === 12) {
        twelfthMinutes += splitMinutes;
      }
      splitBlockCount++;
    }
  };

  if (phaseState.phase === "consolidation") {
    const { target: twelfthTarget, minimum: twelfthMinimum } = computeTwelfthTargetShare(phaseState.daysRemaining);
    const twelfthQueue = ranked.filter((row) => row.topicClass === 12);
    const supportQueue = ranked.filter((row) => row.topicClass !== 12 && isLatePhaseEleventhException(row));
    let twelfthIndex = 0;
    let supportIndex = 0;

    while (usedMinutes < totalMinutes) {
      const currentShare = usedMinutes > 0 ? twelfthMinutes / usedMinutes : 1;
      const needsTwelfth = currentShare < twelfthTarget;

      let row: typeof ranked[number] | undefined;
      if (needsTwelfth && twelfthIndex < twelfthQueue.length) {
        row = twelfthQueue[twelfthIndex++];
      } else if (supportIndex < supportQueue.length) {
        row = supportQueue[supportIndex++];
      } else if (twelfthIndex < twelfthQueue.length) {
        row = twelfthQueue[twelfthIndex++];
      }

      if (!row) break;
      pushBlock(row);
    }

    // Enforce minimum 12th share if still under it after the mixed loop.
    while (
      usedMinutes < totalMinutes &&
      (usedMinutes === 0 || twelfthMinutes / usedMinutes < twelfthMinimum) &&
      twelfthIndex < twelfthQueue.length
    ) {
      pushBlock(twelfthQueue[twelfthIndex++]);
    }
  } else {
    for (const row of ranked) {
      if (usedMinutes >= totalMinutes) break;
      pushBlock(row);
    }
  }

  // ── Intra-Day Energy-Aware Ordering ─────────────────────────────────────────
  // Reorder finalized blocks so cognitively demanding work lands early
  // (while mental energy is high) and lighter revision/bridge blocks come later.
  // Block selection is unchanged; only presentation order is affected.
  //
  // slotOrder: 0 = earliest, higher = later in the day.
  //   Hard + low mastery  → slotOrder near 0  (prime morning slot)
  //   Medium              → slotOrder ~0.5
  //   Bridge / revision   → slotOrder ~1      (end-of-day)
  blocks.sort((a, b) => {
    const isBridgeA = a.topicName.endsWith("(Bridge revision)") ? 1 : 0;
    const isBridgeB = b.topicName.endsWith("(Bridge revision)") ? 1 : 0;
    const topicA = topicsById.get(a.topicId);
    const topicB = topicsById.get(b.topicId);
    const demandA = isBridgeA
      ? 0
      : (1 - a.masteryScore) * clamp((topicA?.difficultyLevel ?? 3) / 5, 0.2, 1);
    const demandB = isBridgeB
      ? 0
      : (1 - b.masteryScore) * clamp((topicB?.difficultyLevel ?? 3) / 5, 0.2, 1);
    if (isBridgeA !== isBridgeB) return isBridgeA - isBridgeB;
    if (!behavioral.hasPersonalizedEnergyModel) {
      return demandB - demandA;
    }
    const targetA = clamp((1 - demandA) * 0.9 + demandA * behavioral.preferredHighDemandProgress, 0, 1);
    const targetB = clamp((1 - demandB) * 0.9 + demandB * behavioral.preferredHighDemandProgress, 0, 1);
    const slotA = Math.round(targetA * 3);
    const slotB = Math.round(targetB * 3);
    const weightedTargetA = targetA - 0.08 * demandA * (behavioral.slotPerformance[slotA] - 1);
    const weightedTargetB = targetB - 0.08 * demandB * (behavioral.slotPerformance[slotB] - 1);
    if (Math.abs(weightedTargetA - weightedTargetB) > 1e-6) {
      return weightedTargetA - weightedTargetB;
    }
    return demandB - demandA;
  });

  return {
    date: params.dateSeed,
    scheduledHours: Math.round(scheduledHours * 1000) / 1000,
    blocks,
    daysUntilExam: days,
    isReset,
    riskSignal: {
      ...riskSignal,
      intervention: selectedIntervention,
    },
  };
}

async function loadBehavioralContext(
  profile: ProfileRow,
  topics: TopicRow[],
  daysUntilExamValue: number,
): Promise<BehavioralContext> {
  const since = new Date(Date.now() - BEHAVIOR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const sessions = await db
    .select()
    .from(studySessionsTable)
    .where(gte(studySessionsTable.studiedAt, since))
    .orderBy(desc(studySessionsTable.studiedAt))
    .limit(800);
  return deriveBehavioralContext({
    profile,
    topics,
    sessions,
    daysUntilExamValue,
  });
}

export async function recalculateSchedule(options?: {
  mode?: SchedulerMode;
  staticTopicOrder?: number[];
  tuning?: SchedulerTuning;
  forceIntervention?: PlannerRiskSignal["intervention"] | null;
}): Promise<PlannerOutput> {
  const [profile] = await db.select().from(studentProfileTable).limit(1);
  if (!profile) {
    return {
      date: new Date().toISOString().split("T")[0],
      scheduledHours: 0,
      blocks: [],
      daysUntilExam: 0,
      isReset: false,
      riskSignal: { backlogRisk: 0, fallingBehind: false, intervention: "none" },
    };
  }

  const topics = await db.select().from(topicsTable);
  const today = new Date().toISOString().split("T")[0];
  const days = daysUntil(profile.examDate);
  const behavioralContext = await loadBehavioralContext(profile, topics, days);

  const output = buildSchedulePlan({
    profile,
    topics,
    mode: options?.mode ?? "adaptive",
    dateSeed: today,
    staticTopicOrder: options?.staticTopicOrder,
    tuning: options?.tuning,
    forceIntervention: options?.forceIntervention ?? null,
    behavioralContext,
  });

  logger.info(
    {
      blocks: output.blocks.length,
      scheduledHours: output.scheduledHours,
      mode: options?.mode ?? "adaptive",
      risk: output.riskSignal.backlogRisk,
      intervention: output.riskSignal.intervention,
    },
    "Schedule recalculated",
  );

  return output;
}

export async function applyMasteryUpdate(
  topicId: number,
  testScore: number,
  testScoreMax: number,
): Promise<{ masteryBefore: number; masteryAfter: number }> {
  const [topic] = await db.select().from(topicsTable).where(eq(topicsTable.id, topicId));
  if (!topic) return { masteryBefore: 0, masteryAfter: 0 };

  const masteryBefore = topic.masteryScore;
  const nt = topic.testsCount + 1;
  const alpha = 1 / nt;
  const normalizedScore = testScore / Math.max(testScoreMax, 1);
  const newMastery = topic.masteryScore + alpha * (normalizedScore - topic.masteryScore);
  const masteryAfter = Math.min(Math.max(newMastery, 0), 1);

  // Confidence score grows with practice attempts: asymptotes toward 1
  // after ~20 tests. Uses Wilson-style formula: nt / (nt + 10)
  const newConfidence = nt / (nt + 10);

  await db
    .update(topicsTable)
    .set({
      masteryScore: masteryAfter,
      testsCount: nt,
      confidenceScore: newConfidence,
      updatedAt: new Date(),
    })
    .where(eq(topicsTable.id, topicId));

  await recomputePriorities();
  return { masteryBefore, masteryAfter };
}

export async function recomputePriorities(): Promise<void> {
  const [profile] = await db.select().from(studentProfileTable).limit(1);
  const topics = await db.select().from(topicsTable);
  if (!profile) return;

  const graph = buildAdjacency(topics);
  const days = daysUntil(profile.examDate);
  const topicClasses = new Map<number, AcademicClass>(
    topics.map((topic) => [topic.id, classifyTopicClass(topic)]),
  );
  const engagement: PhaseEngagementContext = {
    twelfthStudiedCount: topics.filter(
      (t) => topicClasses.get(t.id) === 12 && t.lastStudiedAt !== null,
    ).length,
    twelfthTopicCount: topics.filter((t) => topicClasses.get(t.id) === 12).length,
    totalStudiedCount: topics.filter((t) => t.lastStudiedAt !== null).length,
  };
  const phaseState = inferPreparationPhase(days, engagement);
  const tuning: SchedulerTuning = {
    decayConstant: 1,
    capacitySmoothing: 0.8,
    growthRateMultiplier: 1,
  };
  const class11Topics = topics.filter((t) => topicClasses.get(t.id) === 11);
  const daysSinceLast11thStudy = class11Topics.length > 0
    ? Math.min(...class11Topics.map((t) => daysSinceStudied(t.lastStudiedAt)))
    : ELEVENTH_EXPOSURE_BOOST_DAYS;
  const eleventhExposureBoost = 1 + (ELEVENTH_EXPOSURE_BOOST_MAX - 1) *
    smoothstep(1, ELEVENTH_EXPOSURE_BOOST_DAYS, daysSinceLast11thStudy);
  const behavioralContext = await loadBehavioralContext(profile, topics, days);

  for (const topic of topics) {
    const { priority } = computePriorityBreakdown(
      topic,
      profile,
      days,
      tuning,
      graph,
      topicClasses,
      phaseState,
      eleventhExposureBoost,
      behavioralContext,
    );
    await db
      .update(topicsTable)
      .set({ priorityScore: priority })
      .where(eq(topicsTable.id, topic.id));
  }
}

export async function updateCapacityAndDiscipline(
  actualHours: number,
): Promise<void> {
  const [profile] = await db.select().from(studentProfileTable).limit(1);
  if (!profile) return;

  const newCapacity = 0.8 * profile.capacityScore + 0.2 * actualHours;
  const newDiscipline = Math.min(actualHours / Math.max(profile.dailyTargetHours, 0.1), 1);
  const practiceRatio = Math.min(Math.max(profile.activePracticeRatio * 0.9 + 0.1, 0), 1);

  await db
    .update(studentProfileTable)
    .set({
      capacityScore: newCapacity,
      disciplineScore: newDiscipline,
      activePracticeRatio: practiceRatio,
      updatedAt: new Date(),
    })
    .where(eq(studentProfileTable.id, profile.id));
}
