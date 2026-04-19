import { db, topicsTable, studentProfileTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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

  // Proactive 11th maintenance: soft boost for class-11 topics when recent exposure is sparse.
  const topicClassForBoost = topicClasses.get(topic.id) ?? "unknown";
  const exposureBoost = topicClassForBoost === 11 ? eleventhExposureBoost : 1;

  const total = (
    weightage * 0.3 +
    difficulty * 0.2 +
    lowMastery * 0.35 +
    dependencyPressure * 0.1 +
    decayPressure * 0.05
  ) * disciplineMod * temporalWeight * recencyMultiplier * exposureBoost;

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
): "lecture" | "practice" {
  const examPracticeBias = clamp(1 - daysUntilExam / 220, 0, 1);
  const blendedPracticeBias = profile.activePracticeRatio * 0.6 + examPracticeBias * 0.4;
  if (phase === "consolidation" && topic.masteryScore >= 0.5) {
    return "practice";
  }
  return blendedPracticeBias >= 0.45 && topic.masteryScore > 0.25 ? "practice" : "lecture";
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

  const baseHours = geometricCapacity(profile.capacityScore, profile.disciplineScore) * tuning.growthRateMultiplier;
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

    const adaptive = computePriorityBreakdown(topic, profile, days, tuning, graph, topicClasses, phaseState, eleventhExposureBoost);
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
    const minutes = baseBlockMinutes(row.topic, remaining, phaseState.phase);
    if (minutes < 15) return;
    const sessionType = chooseSessionType(profile, row.topic, days, phaseState.phase);
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
    // energy demand: high when difficulty is high and mastery is low.
    const difficulty = (block: ScheduleBlock) =>
      topicClasses.get(block.topicId) === 11 ? 0.4 : 0.6; // 12th assumed harder on average
    const energyA = isBridgeA ? 0 : (1 - a.masteryScore) * difficulty(a);
    const energyB = isBridgeB ? 0 : (1 - b.masteryScore) * difficulty(b);
    // Sort descending by energy demand (high energy first), bridges last.
    if (isBridgeA !== isBridgeB) return isBridgeA - isBridgeB;
    return energyB - energyA;
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

  const output = buildSchedulePlan({
    profile,
    topics,
    mode: options?.mode ?? "adaptive",
    dateSeed: today,
    staticTopicOrder: options?.staticTopicOrder,
    tuning: options?.tuning,
    forceIntervention: options?.forceIntervention ?? null,
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
