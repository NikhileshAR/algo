import { useEffect, useState, useCallback } from "react";
import { getAllMasteryStates, type TopicMasteryState } from "@/lib/local-db/knowledge-state";
import { getTelemetryRepo } from "@/lib/local-db/repositories";
import { computeAdaptivePlan, type AdaptiveInput, type StudyPlanItem } from "@/lib/adaptive-scheduler";
import type { TopicDaySummary } from "@/lib/local-db/schema";

function isoDay(): string {
  return new Date().toISOString().split("T")[0];
}

interface UseAdaptivePlanOptions {
  topics: Array<{
    id: number;
    name: string;
    masteryScore: number;
  }>;
  daysUntilExam: number;
}

export function useAdaptivePlan({ topics, daysUntilExam }: UseAdaptivePlanOptions): {
  plan: StudyPlanItem[];
  isLoading: boolean;
  refresh: () => void;
} {
  const [plan, setPlan] = useState<StudyPlanItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [rev, setRev] = useState(0);

  const refresh = useCallback(() => setRev((r) => r + 1), []);

  useEffect(() => {
    if (topics.length === 0) {
      setPlan([]);
      setIsLoading(false);
      return;
    }

    let active = true;
    setIsLoading(true);

    async function run() {
      const repo = getTelemetryRepo();
      const todaySummary = await repo.summarizeDay(isoDay());

      const summariesMap = new Map<string, TopicDaySummary>(
        todaySummary.topics.map((t) => [t.topic, t]),
      );

      const masteryStatesArr = await getAllMasteryStates();
      const masteryStates = new Map<string, TopicMasteryState>(
        masteryStatesArr.map((s) => [s.topicId, s]),
      );

      const inputs: AdaptiveInput[] = topics.map((t) => ({
        topicId: String(t.id),
        topicName: t.name,
        serverMastery: t.masteryScore,
        daysUntilExam,
      }));

      const result = computeAdaptivePlan(inputs, masteryStates, summariesMap);

      if (!active) {
        return;
      }

      setPlan(result);
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
  }, [topics, daysUntilExam, rev]);

  return { plan, isLoading, refresh };
}
