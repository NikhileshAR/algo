import { useEffect, useState, useCallback } from "react";
import { getAllMasteryStates, type TopicMasteryState } from "@/lib/local-db/knowledge-state";
import { getTelemetryRepo } from "@/lib/local-db/repositories";
import {
  computeSmartRecommendations,
  type SmartRecommendations,
} from "@/lib/recommendations";
import type { AdaptiveInput } from "@/lib/adaptive-scheduler";
import type { TopicDaySummary } from "@/lib/local-db/schema";

function isoDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split("T")[0];
}

interface UseSmartRecommendationsOptions {
  /**
   * Topic list from the API. Each entry needs id, name, subject, masteryScore,
   * and daysUntilExam.
   */
  topics: Array<{
    id: number;
    name: string;
    subject: string;
    masteryScore: number;
  }>;
  daysUntilExam: number;
  /** How many past days to include for focus-trend calculation. */
  lookbackDays?: number;
}

export function useSmartRecommendations({
  topics,
  daysUntilExam,
  lookbackDays = 7,
}: UseSmartRecommendationsOptions): {
  data: SmartRecommendations | null;
  isLoading: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<SmartRecommendations | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [rev, setRev] = useState(0);

  const refresh = useCallback(() => setRev((r) => r + 1), []);

  useEffect(() => {
    if (topics.length === 0) {
      setIsLoading(false);
      return;
    }

    let active = true;
    setIsLoading(true);

    async function run() {
      const repo = getTelemetryRepo();

      // Load today's telemetry summary
      const todaySummary = await repo.summarizeDay(isoDay(0));

      // Build a map of topic summaries keyed by topic name (how classifier returns them)
      const todaySummariesMap = new Map<string, TopicDaySummary>(
        todaySummary.topics.map((t) => [t.topic, t]),
      );

      // Load all persisted mastery states
      const masteryStatesArr = await getAllMasteryStates();
      const masteryStates = new Map<string, TopicMasteryState>(
        masteryStatesArr.map((s) => [s.topicId, s]),
      );

      // Collect recent focus ratios for trend
      const focusRatios: number[] = [];
      for (let d = lookbackDays - 1; d >= 0; d--) {
        const day = isoDay(-d);
        const s = await repo.schedulerInput(day);
        focusRatios.push(s.globalFocusRatio);
      }

      // Map API topics to AdaptiveInput
      const adaptiveInputs: AdaptiveInput[] = topics.map((t) => ({
        topicId: String(t.id),
        topicName: t.name,
        serverMastery: t.masteryScore,
        daysUntilExam,
      }));

      const result = computeSmartRecommendations({
        topics: adaptiveInputs,
        masteryStates,
        todaySummaries: todaySummariesMap,
        recentFocusRatios: focusRatios,
      });

      if (!active) {
        return;
      }

      setData(result);
      setIsLoading(false);
    }

    void run().catch(() => {
      if (active) {
        setIsLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, [topics, daysUntilExam, lookbackDays, rev]);

  return { data, isLoading, refresh };
}
