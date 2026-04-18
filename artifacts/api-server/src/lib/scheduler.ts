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

function daysSinceStudied(lastStudiedAt: Date | null): number {
  if (!lastStudiedAt) return 999;
  const diff = Date.now() - new Date(lastStudiedAt).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * Ebbinghaus-style retention: R = e^(-t/S)
 * Stability S scales with mastery: mastery=0 → S=3d, mastery=1 → S=21d.
 */
function forgettingRetention(mastery: number, days: number, decayConstant = 1): number {
  const stability = 3 + mastery * 18;
  return Math.exp((-days / Math.max(stability, 0.1)) * decayConstant);
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
}

const TARGET_ACTIVE_PRACTICE_RATIO = 0.5;

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
}

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
): PriorityBreakdown {
  const daysDormant = daysSinceStudied(topic.lastStudiedAt);
  const retention = forgettingRetention(topic.masteryScore, daysDormant, tuning.decayConstant);
  const lowMastery = clamp(1 - topic.masteryScore * retention, 0, 1);
  const weightage = clamp(daysUntilExam > 0 ? topic.estimatedHours / daysUntilExam : topic.estimatedHours, 0, 10);
  const difficulty = clamp(topic.difficultyLevel / 5, 0.2, 1);
  const unlockedDownstreamTopics = countUnlockedDownstream(topic.id, graph);
  const dependencyPressure = clamp(unlockedDownstreamTopics / 5, 0, 1);
  const decayPressure = clamp(1 - retention, 0, 1);
  const practicePressure = clamp(profile.activePracticeRatio < 0.35 ? (0.35 - profile.activePracticeRatio) / 0.35 : 0, 0, 1);
  const performancePressure = clamp(1 - topic.confidenceScore, 0, 1);
  const disciplineMod = 1 / Math.max(profile.disciplineScore, 0.1);

  const total = (
    weightage * 0.3 +
    difficulty * 0.2 +
    lowMastery * 0.35 +
    dependencyPressure * 0.1 +
    decayPressure * 0.05
  ) * disciplineMod;

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
    },
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
  const openTopics = topics.filter((t) => !t.isCompleted);
  const days = daysUntil(profile.examDate);
  const riskSignal = scoreBacklogRisk(profile, days, openTopics.length);
  const selectedIntervention = params.forceIntervention ?? riskSignal.intervention;

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

  const staticOrderIndex = new Map<number, number>(
    (params.staticTopicOrder ?? []).map((topicId, index) => [topicId, index]),
  );

  const scored = openTopics.map((topic) => {
    const deps = parseDeps(topic.prerequisites);
    const allDepsComplete = deps.every((depId) => {
      const dep = topics.find((candidate) => candidate.id === depId);
      return dep ? dep.masteryScore >= 0.6 || dep.isCompleted : true;
    });

    const adaptive = computePriorityBreakdown(topic, profile, days, tuning, graph);
    const randomPriority = deterministicHash(`${params.dateSeed}:${topic.id}`);
    const staticPriority = staticOrderIndex.has(topic.id)
      ? 1 / (1 + (staticOrderIndex.get(topic.id) ?? Number.MAX_SAFE_INTEGER))
      : adaptive.priority;

    let modePriority = adaptive.priority;
    if (params.mode === "random") {
      modePriority = randomPriority;
    } else if (params.mode === "static") {
      modePriority = staticPriority;
    }

    return {
      topic,
      deps,
      allDepsComplete,
      priority: allDepsComplete ? modePriority : 0,
      explainability: adaptive.explainability,
    };
  });

  scored.sort((a, b) => b.priority - a.priority);

  let ranked = scored.filter((s) => s.allDepsComplete);
  if (selectedIntervention === "priority_concentration" || selectedIntervention === "early_reset") {
    ranked = ranked.slice(0, Math.max(2, Math.ceil(ranked.length * 0.35)));
  }

  const blocks: ScheduleBlock[] = [];
  let usedMinutes = 0;

  for (const row of ranked) {
    if (usedMinutes >= totalMinutes) break;

    const sessionType: "lecture" | "practice" =
      profile.activePracticeRatio >= 0.5 && row.topic.masteryScore > 0.3 ? "practice" : "lecture";

    const baseMinutes = Math.min(
      Math.round(Math.min(row.topic.estimatedHours * 60, 90)),
      totalMinutes - usedMinutes,
    );
    if (baseMinutes < 15) continue;

    blocks.push({
      topicId: row.topic.id,
      topicName: row.topic.name,
      subject: row.topic.subject,
      sessionType,
      durationMinutes: baseMinutes,
      priorityScore: Math.round(row.priority * 1000) / 1000,
      masteryScore: row.topic.masteryScore,
      explanation: row.explainability,
    });
    usedMinutes += baseMinutes;
  }

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
  const tuning: SchedulerTuning = {
    decayConstant: 1,
    capacitySmoothing: 0.8,
    growthRateMultiplier: 1,
  };
  for (const topic of topics) {
    const { priority } = computePriorityBreakdown(
      topic,
      profile,
      days,
      tuning,
      graph,
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
