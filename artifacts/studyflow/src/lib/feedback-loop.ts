import {
  ensureMasteryState,
  applySessionToMastery,
  putMasteryState,
} from "@/lib/local-db/knowledge-state";
import { getTelemetryRepo } from "@/lib/local-db/repositories";

/**
 * Called once after a study session completes.
 * Updates the local mastery state for the given topic based on telemetry
 * quality signals so the adaptive scheduler sees fresh data immediately.
 */
export async function runFeedbackLoop(params: {
  topicId: string;
  topicName: string;
  /** Initial mastery from the server (used to bootstrap if no local state). */
  serverMastery: number;
  /** How many minutes were focused in this session. */
  focusedMinutes: number;
}): Promise<void> {
  const { topicId, serverMastery, focusedMinutes } = params;

  // Get or create local mastery state
  const state = await ensureMasteryState(topicId, serverMastery);

  // Pull today's telemetry for quality signals
  const repo = getTelemetryRepo();
  const today = new Date().toISOString().split("T")[0];
  const summary = await repo.summarizeDay(today);
  const topicSummary = summary.topics.find((t) => t.topic === params.topicName);

  const qualityScore = topicSummary?.qualityScore ?? 0.5;

  const updated = applySessionToMastery(state, {
    qualityScore,
    focusedMinutes: Math.max(0, focusedMinutes),
  });

  await putMasteryState(updated);
}
