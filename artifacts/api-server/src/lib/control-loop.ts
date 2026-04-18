import { db, schedulesTable, studentProfileTable, studySessionsTable, topicsTable } from "@workspace/db";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { buildSchedulePlan, type PlannerRiskSignal, type SchedulerMode, type SchedulerTuning } from "./scheduler";

type TopicRow = typeof topicsTable.$inferSelect;
type ProfileRow = typeof studentProfileTable.$inferSelect;

export interface SimulationDayState {
  day: number;
  date: string;
  mode: SchedulerMode;
  scheduledHours: number;
  studiedHours: number;
  averageMastery: number;
  discipline: number;
  capacity: number;
  activePracticeRatio: number;
  resetTriggered: boolean;
}

export interface SimulationMetrics {
  mode: SchedulerMode;
  totalStudyHoursAccumulated: number;
  weightedMasteryProgression: number;
  highPriorityTopicCoverage: number;
  numberOfResetsTriggered: number;
  timeline: SimulationDayState[];
}

export interface SimulationComparison {
  baselineRandom: SimulationMetrics;
  staticScheduling: SimulationMetrics;
  adaptiveScheduling: SimulationMetrics;
  complianceSequence: number[];
}

export interface ForecastPoint {
  day: number;
  date: string;
  expectedCoverage: number;
  expectedAverageMastery: number;
}

export interface ForecastResult {
  expectedCoverageByExamDate: number;
  expectedMasteryProgression: ForecastPoint[];
  riskOfFallingBehind: number;
  riskSignal: PlannerRiskSignal;
}

export interface PerformanceGap {
  expectedHours: number;
  actualHours: number;
  studyHoursDeviation: number;
  expectedTopicCompletion: number;
  actualTopicCompletion: number;
  topicCompletionDeviation: number;
  disciplineMismatch: number;
  efficiencyOfTimeSpent: number;
}

export interface CalibrationResult {
  tuning: SchedulerTuning;
  detectedBias: "balanced" | "overestimation" | "underestimation";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function random() {
    t += 0x6D2B79F5;
    let z = t;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function toDateString(base: Date, dayOffset: number): string {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().split("T")[0];
}

function cloneTopics(topics: TopicRow[]): TopicRow[] {
  return topics.map((topic) => ({ ...topic }));
}

function avgMastery(topics: TopicRow[]): number {
  if (topics.length === 0) return 0;
  return topics.reduce((acc, topic) => acc + topic.masteryScore, 0) / topics.length;
}

function decayTopics(topics: TopicRow[], tuning: SchedulerTuning): void {
  for (const topic of topics) {
    const decayed = topic.masteryScore * Math.exp(-0.015 * tuning.decayConstant);
    topic.masteryScore = clamp(decayed, 0, 1);
  }
}

function applyPracticeGain(topic: TopicRow, sessionType: "lecture" | "practice", completedRatio: number): void {
  const qualitySignal = sessionType === "practice" ? 0.74 : 0.58;
  const alpha = 0.14 + topic.confidenceScore * 0.08;
  const delta = alpha * completedRatio * (qualitySignal - topic.masteryScore);
  topic.masteryScore = clamp(topic.masteryScore + delta, 0, 1);
  topic.confidenceScore = clamp(topic.confidenceScore + 0.03 * completedRatio, 0, 1);
  topic.testsCount += sessionType === "practice" ? 1 : 0;
}

function extractHighPriorityTopicIds(topics: TopicRow[]): Set<number> {
  const scored = topics
    .map((topic) => ({
      topicId: topic.id,
      score: topic.estimatedHours * (topic.difficultyLevel / 5) * (1 - topic.masteryScore),
    }))
    .sort((a, b) => b.score - a.score);

  const count = Math.max(1, Math.ceil(scored.length * 0.3));
  return new Set(scored.slice(0, count).map((item) => item.topicId));
}

function applyPsychologicalReset(profile: ProfileRow, topics: TopicRow[]): void {
  profile.capacityScore = Math.max(1.5, profile.capacityScore * 0.9);
  profile.disciplineScore = Math.max(0.5, profile.disciplineScore);
  for (const topic of topics) {
    if (topic.masteryScore < 0.35) {
      topic.masteryScore = Math.min(0.45, topic.masteryScore + 0.04);
    }
  }
}

function runSingleModeSimulation(params: {
  mode: SchedulerMode;
  horizonDays: number;
  startDate: Date;
  profile: ProfileRow;
  topics: TopicRow[];
  complianceSequence: number[];
  tuning: SchedulerTuning;
  staticTopicOrder: number[];
}): SimulationMetrics {
  const profile = { ...params.profile };
  const topics = cloneTopics(params.topics);
  const highPriorityTopicIds = extractHighPriorityTopicIds(topics);
  const timeline: SimulationDayState[] = [];

  let totalStudyHoursAccumulated = 0;
  let weightedMasteryAccumulator = 0;
  let highPriorityStudiedMinutes = 0;
  let highPriorityTotalMinutes = 0;
  let resets = 0;
  let lowComplianceStreak = 0;

  for (let day = 0; day < params.horizonDays; day++) {
    decayTopics(topics, params.tuning);
    const date = toDateString(params.startDate, day);
    const compliance = params.complianceSequence[day] ?? 0.6;
    const deterministicDiscipline = clamp(profile.disciplineScore * 0.8 + compliance * 0.2, 0.05, 1);
    profile.disciplineScore = deterministicDiscipline;

    const plan = buildSchedulePlan({
      profile,
      topics,
      mode: params.mode,
      dateSeed: date,
      staticTopicOrder: params.staticTopicOrder,
      tuning: params.tuning,
    });

    const scheduledHours = plan.scheduledHours;
    const scheduledMinutes = Math.max(0, Math.round(scheduledHours * 60));
    const studiedMinutesBudget = Math.round(scheduledMinutes * clamp(compliance, 0.05, 1));
    let remaining = studiedMinutesBudget;
    let practicedMinutes = 0;
    let studiedMinutes = 0;

    for (const block of plan.blocks) {
      if (remaining <= 0) break;
      const completed = Math.min(block.durationMinutes, remaining);
      const completionRatio = completed / Math.max(block.durationMinutes, 1);
      remaining -= completed;
      studiedMinutes += completed;

      const topic = topics.find((t) => t.id === block.topicId);
      if (!topic) continue;
      applyPracticeGain(topic, block.sessionType, completionRatio);
      if (block.sessionType === "practice") {
        practicedMinutes += completed;
      }
      if (highPriorityTopicIds.has(block.topicId)) {
        highPriorityStudiedMinutes += completed;
      }
      highPriorityTotalMinutes += block.durationMinutes;
    }

    const studiedHours = studiedMinutes / 60;
    totalStudyHoursAccumulated += studiedHours;
    weightedMasteryAccumulator += avgMastery(topics) * (0.6 + 0.4 * deterministicDiscipline);

    const practiceRatioToday = studiedMinutes > 0 ? practicedMinutes / studiedMinutes : 0;
    profile.activePracticeRatio = clamp(profile.activePracticeRatio * 0.85 + practiceRatioToday * 0.15, 0, 1);

    const growthSignal = clamp(deterministicDiscipline - 0.45, -0.2, 0.35);
    const grownCapacity = profile.capacityScore * (1 + 0.03 * params.tuning.growthRateMultiplier * growthSignal);
    profile.capacityScore = clamp(
      params.tuning.capacitySmoothing * profile.capacityScore + (1 - params.tuning.capacitySmoothing) * grownCapacity,
      1,
      14,
    );

    lowComplianceStreak = compliance < 0.45 ? lowComplianceStreak + 1 : 0;
    const resetTriggered = lowComplianceStreak >= 5 || plan.riskSignal.intervention === "early_reset";
    if (resetTriggered) {
      resets += 1;
      lowComplianceStreak = 0;
      applyPsychologicalReset(profile, topics);
    }

    timeline.push({
      day,
      date,
      mode: params.mode,
      scheduledHours: Math.round(scheduledHours * 1000) / 1000,
      studiedHours: Math.round(studiedHours * 1000) / 1000,
      averageMastery: Math.round(avgMastery(topics) * 1000) / 1000,
      discipline: Math.round(profile.disciplineScore * 1000) / 1000,
      capacity: Math.round(profile.capacityScore * 1000) / 1000,
      activePracticeRatio: Math.round(profile.activePracticeRatio * 1000) / 1000,
      resetTriggered,
    });
  }

  const weightedMasteryProgression = params.horizonDays > 0
    ? weightedMasteryAccumulator / params.horizonDays
    : 0;
  const highPriorityTopicCoverage = highPriorityTotalMinutes > 0
    ? highPriorityStudiedMinutes / highPriorityTotalMinutes
    : 0;

  return {
    mode: params.mode,
    totalStudyHoursAccumulated: Math.round(totalStudyHoursAccumulated * 1000) / 1000,
    weightedMasteryProgression: Math.round(weightedMasteryProgression * 1000) / 1000,
    highPriorityTopicCoverage: Math.round(highPriorityTopicCoverage * 1000) / 1000,
    numberOfResetsTriggered: resets,
    timeline,
  };
}

function deterministicComplianceSequence(seed: string, days: number): number[] {
  const random = mulberry32(seedFromString(seed));
  const values: number[] = [];
  for (let i = 0; i < days; i++) {
    const baseline = 0.65 + 0.12 * Math.sin((2 * Math.PI * i) / 14);
    const noise = (random() - 0.5) * 0.28;
    values.push(Math.round(clamp(baseline + noise, 0.15, 1) * 1000) / 1000);
  }
  return values;
}

function estimateCoverage(topics: TopicRow[]): number {
  if (topics.length === 0) return 0;
  const completed = topics.filter((topic) => topic.masteryScore >= 0.8 || topic.isCompleted).length;
  return completed / topics.length;
}

export function runForwardForecast(params: {
  profile: ProfileRow;
  topics: TopicRow[];
  daysUntilExam: number;
  tuning: SchedulerTuning;
}): ForecastResult {
  const startDate = new Date();
  const horizonDays = Math.max(1, params.daysUntilExam);
  const complianceSequence = deterministicComplianceSequence(
    `${params.profile.id}:${params.profile.disciplineScore.toFixed(3)}:${horizonDays}`,
    horizonDays,
  );

  const staticTopicOrder = params.topics.map((topic) => topic.id);
  const simulation = runSingleModeSimulation({
    mode: "adaptive",
    horizonDays,
    startDate,
    profile: params.profile,
    topics: params.topics,
    complianceSequence,
    tuning: params.tuning,
    staticTopicOrder,
  });

  const expectedMasteryProgression: ForecastPoint[] = simulation.timeline.map((entry) => ({
    day: entry.day,
    date: entry.date,
    expectedCoverage: 0,
    expectedAverageMastery: entry.averageMastery,
  }));

  const topicsProjection = cloneTopics(params.topics);
  const coverageProjection: number[] = [];
  for (const point of simulation.timeline) {
    const pseudoLift = clamp(point.studiedHours / Math.max(params.profile.dailyTargetHours, 0.5), 0, 1) * 0.025;
    for (const topic of topicsProjection) {
      topic.masteryScore = clamp(topic.masteryScore + pseudoLift * (1 - topic.masteryScore), 0, 1);
    }
    coverageProjection.push(estimateCoverage(topicsProjection));
  }

  for (let i = 0; i < expectedMasteryProgression.length; i++) {
    expectedMasteryProgression[i].expectedCoverage = Math.round((coverageProjection[i] ?? 0) * 1000) / 1000;
  }

  const expectedCoverageByExamDate = coverageProjection[coverageProjection.length - 1] ?? 0;
  const expectedAverageMastery = expectedMasteryProgression[expectedMasteryProgression.length - 1]?.expectedAverageMastery ?? 0;
  const paceGap = clamp(0.8 - expectedCoverageByExamDate, 0, 1);
  const masteryGap = clamp(0.75 - expectedAverageMastery, 0, 1);
  const riskOfFallingBehind = clamp(paceGap * 0.65 + masteryGap * 0.35, 0, 1);
  const intervention: PlannerRiskSignal["intervention"] =
    riskOfFallingBehind >= 0.85
      ? "early_reset"
      : riskOfFallingBehind >= 0.7
      ? "priority_concentration"
      : riskOfFallingBehind >= 0.5
      ? "reduced_targets"
      : "none";

  return {
    expectedCoverageByExamDate: Math.round(expectedCoverageByExamDate * 1000) / 1000,
    expectedMasteryProgression,
    riskOfFallingBehind: Math.round(riskOfFallingBehind * 1000) / 1000,
    riskSignal: {
      backlogRisk: Math.round(riskOfFallingBehind * 1000) / 1000,
      fallingBehind: riskOfFallingBehind >= 0.5,
      intervention,
    },
  };
}

export async function computePerformanceGap(daysLookback = 14): Promise<PerformanceGap> {
  const today = new Date();
  const start = new Date(today.getTime());
  start.setUTCDate(start.getUTCDate() - daysLookback);
  const startDay = start.toISOString().split("T")[0];
  const endDay = today.toISOString().split("T")[0];

  const schedules = await db
    .select()
    .from(schedulesTable)
    .where(and(gte(schedulesTable.date, startDay), lte(schedulesTable.date, endDay)))
    .orderBy(desc(schedulesTable.date));

  const sessions = await db
    .select()
    .from(studySessionsTable)
    .where(gte(studySessionsTable.studiedAt, start))
    .orderBy(desc(studySessionsTable.studiedAt));

  const expectedHours = schedules.reduce((sum, schedule) => sum + schedule.scheduledHours, 0);
  const actualHours = sessions.reduce((sum, session) => sum + session.durationMinutes / 60, 0);
  const studyHoursDeviation = actualHours - expectedHours;

  const expectedTopicMinutes = new Map<number, number>();
  for (const schedule of schedules) {
    let blocks: Array<{ topicId: number; durationMinutes: number }> = [];
    try {
      blocks = JSON.parse(schedule.blocks) as Array<{ topicId: number; durationMinutes: number }>;
    } catch {
      blocks = [];
    }
    for (const block of blocks) {
      expectedTopicMinutes.set(
        block.topicId,
        (expectedTopicMinutes.get(block.topicId) ?? 0) + block.durationMinutes,
      );
    }
  }

  const actualTopicMinutes = new Map<number, number>();
  for (const session of sessions) {
    actualTopicMinutes.set(
      session.topicId,
      (actualTopicMinutes.get(session.topicId) ?? 0) + session.durationMinutes,
    );
  }

  const expectedTopicCompletion = expectedTopicMinutes.size > 0
    ? Array.from(expectedTopicMinutes.values()).reduce((sum, minutes) => sum + (minutes > 0 ? 1 : 0), 0) / expectedTopicMinutes.size
    : 0;
  const actualTopicCompletion = expectedTopicMinutes.size > 0
    ? Array.from(expectedTopicMinutes.keys()).reduce((sum, topicId) => {
        const expected = expectedTopicMinutes.get(topicId) ?? 0;
        const actual = actualTopicMinutes.get(topicId) ?? 0;
        return sum + clamp(actual / Math.max(expected, 1), 0, 1);
      }, 0) / expectedTopicMinutes.size
    : 0;
  const topicCompletionDeviation = actualTopicCompletion - expectedTopicCompletion;

  const disciplineExpected = expectedHours > 0 ? clamp(actualHours / expectedHours, 0, 2) : 0;
  const [profile] = await db.select().from(studentProfileTable).limit(1);
  const disciplineMismatch = profile ? disciplineExpected - profile.disciplineScore : 0;

  const scoredSessions = sessions.filter((session) => session.testScore !== null && session.testScoreMax !== null);
  const quality = scoredSessions.length > 0
    ? scoredSessions.reduce((sum, session) => {
        const normalized = (session.testScore ?? 0) / Math.max(session.testScoreMax ?? 1, 1);
        return sum + clamp(normalized, 0, 1);
      }, 0) / scoredSessions.length
    : 0.5;
  const efficiencyOfTimeSpent = actualHours > 0 ? clamp((quality * scoredSessions.length) / Math.max(actualHours, 1), 0, 1) : 0;

  return {
    expectedHours: Math.round(expectedHours * 1000) / 1000,
    actualHours: Math.round(actualHours * 1000) / 1000,
    studyHoursDeviation: Math.round(studyHoursDeviation * 1000) / 1000,
    expectedTopicCompletion: Math.round(expectedTopicCompletion * 1000) / 1000,
    actualTopicCompletion: Math.round(actualTopicCompletion * 1000) / 1000,
    topicCompletionDeviation: Math.round(topicCompletionDeviation * 1000) / 1000,
    disciplineMismatch: Math.round(disciplineMismatch * 1000) / 1000,
    efficiencyOfTimeSpent: Math.round(efficiencyOfTimeSpent * 1000) / 1000,
  };
}

export function calibrateParameters(params: {
  profile: ProfileRow;
  gap: PerformanceGap;
  baseTuning?: SchedulerTuning;
}): CalibrationResult {
  const baseline: SchedulerTuning = params.baseTuning ?? {
    decayConstant: 1,
    capacitySmoothing: 0.8,
    growthRateMultiplier: 1,
  };

  const deviationRatio = params.gap.expectedHours > 0
    ? params.gap.studyHoursDeviation / params.gap.expectedHours
    : 0;
  const completionBias = params.gap.topicCompletionDeviation;
  const under = deviationRatio < -0.12 || completionBias < -0.08;
  const over = deviationRatio > 0.12 || completionBias > 0.08;

  const detectedBias = under ? "overestimation" : over ? "underestimation" : "balanced";
  const biasDirection = under ? 1 : over ? -1 : 0;

  const decayConstant = clamp(baseline.decayConstant + biasDirection * 0.04, 0.7, 1.4);
  const capacitySmoothing = clamp(baseline.capacitySmoothing + (under ? 0.04 : over ? -0.03 : 0), 0.65, 0.92);
  const growthRateMultiplier = clamp(
    baseline.growthRateMultiplier + (under ? -0.07 : over ? 0.04 : 0),
    0.75,
    1.25,
  );

  return {
    tuning: {
      decayConstant: Math.round(decayConstant * 1000) / 1000,
      capacitySmoothing: Math.round(capacitySmoothing * 1000) / 1000,
      growthRateMultiplier: Math.round(growthRateMultiplier * 1000) / 1000,
    },
    detectedBias,
  };
}

export async function runSimulationComparison(params?: {
  horizonDays?: number;
  seed?: string;
  tuning?: SchedulerTuning;
}): Promise<SimulationComparison> {
  const [profile] = await db.select().from(studentProfileTable).limit(1);
  const topics = await db.select().from(topicsTable);

  if (!profile || topics.length === 0) {
    const empty: SimulationMetrics = {
      mode: "adaptive",
      totalStudyHoursAccumulated: 0,
      weightedMasteryProgression: 0,
      highPriorityTopicCoverage: 0,
      numberOfResetsTriggered: 0,
      timeline: [],
    };
    return {
      baselineRandom: { ...empty, mode: "random" },
      staticScheduling: { ...empty, mode: "static" },
      adaptiveScheduling: { ...empty, mode: "adaptive" },
      complianceSequence: [],
    };
  }

  const horizonDays = Math.max(1, params?.horizonDays ?? 180);
  const seed = params?.seed ?? `${profile.id}:${profile.examDate}:${horizonDays}`;
  const complianceSequence = deterministicComplianceSequence(seed, horizonDays);
  const startDate = new Date();
  const staticTopicOrder = topics
    .map((topic) => ({
      id: topic.id,
      rank: topic.priorityScore,
    }))
    .sort((a, b) => b.rank - a.rank)
    .map((entry) => entry.id);

  const tuning = params?.tuning ?? {
    decayConstant: 1,
    capacitySmoothing: 0.8,
    growthRateMultiplier: 1,
  };

  const baselineRandom = runSingleModeSimulation({
    mode: "random",
    horizonDays,
    startDate,
    profile,
    topics,
    complianceSequence,
    tuning,
    staticTopicOrder,
  });
  const staticScheduling = runSingleModeSimulation({
    mode: "static",
    horizonDays,
    startDate,
    profile,
    topics,
    complianceSequence,
    tuning,
    staticTopicOrder,
  });
  const adaptiveScheduling = runSingleModeSimulation({
    mode: "adaptive",
    horizonDays,
    startDate,
    profile,
    topics,
    complianceSequence,
    tuning,
    staticTopicOrder,
  });

  return {
    baselineRandom,
    staticScheduling,
    adaptiveScheduling,
    complianceSequence,
  };
}

export async function getCurrentControlSnapshot(): Promise<{
  forecast: ForecastResult;
  performanceGap: PerformanceGap;
  calibration: CalibrationResult;
}> {
  const [profile] = await db.select().from(studentProfileTable).limit(1);
  const topics = await db.select().from(topicsTable);

  if (!profile) {
    const emptyGap: PerformanceGap = {
      expectedHours: 0,
      actualHours: 0,
      studyHoursDeviation: 0,
      expectedTopicCompletion: 0,
      actualTopicCompletion: 0,
      topicCompletionDeviation: 0,
      disciplineMismatch: 0,
      efficiencyOfTimeSpent: 0,
    };
    const tuning: SchedulerTuning = {
      decayConstant: 1,
      capacitySmoothing: 0.8,
      growthRateMultiplier: 1,
    };
    return {
      forecast: {
        expectedCoverageByExamDate: 0,
        expectedMasteryProgression: [],
        riskOfFallingBehind: 0,
        riskSignal: { backlogRisk: 0, fallingBehind: false, intervention: "none" },
      },
      performanceGap: emptyGap,
      calibration: { tuning, detectedBias: "balanced" },
    };
  }

  const gap = await computePerformanceGap(14);
  const calibration = calibrateParameters({ profile, gap });
  const daysLeft = Math.max(1, Math.ceil((new Date(profile.examDate).getTime() - Date.now()) / 86_400_000));
  const forecast = runForwardForecast({
    profile,
    topics,
    daysUntilExam: daysLeft,
    tuning: calibration.tuning,
  });

  return { forecast, performanceGap: gap, calibration };
}

export async function computeDailyExpectedActualHours(date: string): Promise<{
  expectedHours: number;
  actualHours: number;
}> {
  const [schedule] = await db.select().from(schedulesTable).where(eq(schedulesTable.date, date)).limit(1);
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);
  const sessions = await db
    .select({
      total: sql<number>`COALESCE(SUM(${studySessionsTable.durationMinutes}), 0)`,
    })
    .from(studySessionsTable)
    .where(and(gte(studySessionsTable.studiedAt, dayStart), lte(studySessionsTable.studiedAt, dayEnd)));

  const expectedHours = schedule?.scheduledHours ?? 0;
  const actualHours = ((sessions[0]?.total ?? 0) as number) / 60;
  return {
    expectedHours: Math.round(expectedHours * 1000) / 1000,
    actualHours: Math.round(actualHours * 1000) / 1000,
  };
}
