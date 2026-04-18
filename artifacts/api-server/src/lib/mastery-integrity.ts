import { db, schedulesTable, studySessionsTable, topicsTable } from "@workspace/db";
import { gt } from "drizzle-orm";
import { logger } from "./logger";

interface MasteryStats {
  count: number;
  variance: number;
  allIdentical: boolean;
  allZero: boolean;
  highMasteryRatio: number;
}

// If an overwhelming majority of topics are near-perfect without any real
// session history, this is treated as corrupted bootstrap state.
const HIGH_MASTERY_CORRUPTION_THRESHOLD = 0.8;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function computeMasteryStats(values: number[]): MasteryStats {
  const count = values.length;
  if (count === 0) {
    return {
      count: 0,
      variance: 0,
      allIdentical: true,
      allZero: true,
      highMasteryRatio: 0,
    };
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
  const highMasteryRatio = values.filter((value) => value >= 0.95).length / count;
  const allIdentical = values.every((value) => value === values[0]);
  const allZero = values.every((value) => value === 0);

  return {
    count,
    variance: round(variance),
    allIdentical,
    allZero,
    highMasteryRatio: round(highMasteryRatio),
  };
}

async function hasRealSessionHistory(): Promise<boolean> {
  const [realSession] = await db
    .select({ id: studySessionsTable.id })
    .from(studySessionsTable)
    .where(gt(studySessionsTable.durationMinutes, 0))
    .limit(1);

  return Boolean(realSession);
}

async function runSoftReset(reason: "uniform_non_zero_mastery" | "bootstrap_mastery_corruption"): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(topicsTable)
      .set({
        masteryScore: 0,
        confidenceScore: 0,
        priorityScore: 0,
        testsCount: 0,
        lastStudiedAt: null,
        updatedAt: new Date(),
      });

    await tx.delete(schedulesTable);
  });

  logger.warn({ reason }, "Mastery anomaly detected; soft reset applied");
}

export async function ensureMasteryIntegrityOnLoad(): Promise<void> {
  const topics = await db.select({ masteryScore: topicsTable.masteryScore }).from(topicsTable);
  if (topics.length === 0) {
    return;
  }

  const stats = computeMasteryStats(topics.map((topic) => topic.masteryScore));
  if (stats.allIdentical) {
    logger.warn(
      { topicCount: stats.count, variance: stats.variance, allZero: stats.allZero },
      "Mastery anomaly flag: all mastery values identical on load",
    );
  }

  const noRealHistory = !(await hasRealSessionHistory());
  const bootstrapCorruption = stats.highMasteryRatio >= HIGH_MASTERY_CORRUPTION_THRESHOLD && noRealHistory;
  const uniformNonZero = stats.allIdentical && !stats.allZero;

  if (!bootstrapCorruption && !uniformNonZero) {
    return;
  }

  await runSoftReset(bootstrapCorruption ? "bootstrap_mastery_corruption" : "uniform_non_zero_mastery");
}
