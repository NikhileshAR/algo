import { runValidationPipeline } from "@/lib/local-db/validation";
import type { ValidationMode } from "@/lib/local-db/schema";

function pipelineLockKey(mode: ValidationMode, date: string): string {
  return `sf.validation.pipeline.${mode}.${date}`;
}

const PIPELINE_LOCK_TTL_MS = 15 * 60 * 1000;
// 15 minutes avoids repeated writes during active navigation while still
// allowing updated snapshots in the same day.

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

export async function syncDailyValidationFromApi(params: {
  mode: ValidationMode;
  date: string;
  sessions: Array<{ studiedAt?: string; durationMinutes: number }>;
  schedule: { scheduledHours?: number; isReset?: boolean };
  profile: { disciplineScore: number; capacityScore: number };
  topics: Array<{ masteryScore: number; priorityScore: number }>;
  completion?: number;
}): Promise<void> {
  const key = pipelineLockKey(params.mode, params.date);
  try {
    const raw = sessionStorage.getItem(key);
    const lastRunTs = raw ? Number(raw) : 0;
    if (Number.isFinite(lastRunTs) && Date.now() - lastRunTs < PIPELINE_LOCK_TTL_MS) {
      return;
    }
  } catch {
    // ignore storage availability issues
  }

  const actualHours = params.sessions
    .filter((s) => typeof s.studiedAt === "string" && s.studiedAt.startsWith(params.date))
    .reduce((sum, s) => sum + s.durationMinutes / 60, 0);
  const sessionsCompleted = params.sessions.filter(
    (s) => typeof s.studiedAt === "string" && s.studiedAt.startsWith(params.date),
  ).length;
  const weighted = params.topics.reduce(
    (acc, topic) => {
      const weight = Math.max(topic.priorityScore, 0.01);
      return {
        weightedMastery: acc.weightedMastery + topic.masteryScore * weight,
        totalWeight: acc.totalWeight + weight,
      };
    },
    { weightedMastery: 0, totalWeight: 0 },
  );
  const weightedNow = weighted.totalWeight > 0 ? weighted.weightedMastery / weighted.totalWeight : 0;
  const fallbackCompletion = params.schedule.scheduledHours && params.schedule.scheduledHours > 0
    ? clamp(actualHours / params.schedule.scheduledHours)
    : 0;
  const completionRatio = params.completion !== undefined
    ? clamp(params.completion)
    : fallbackCompletion;

  await runValidationPipeline({
    mode: params.mode,
    date: params.date,
    plannedHours: params.schedule.scheduledHours ?? 0,
    actualHours,
    sessionsCompleted,
    resetTriggered: Boolean(params.schedule.isReset),
    disciplineScore: params.profile.disciplineScore,
    capacityEstimate: params.profile.capacityScore,
    highPriorityProgress: weightedNow,
    backlogLevel: 1 - completionRatio,
  });

  try {
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    // ignore storage availability issues
  }
}
