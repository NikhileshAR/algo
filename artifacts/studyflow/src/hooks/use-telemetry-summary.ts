import { useEffect, useState } from "react";
import type { TelemetryDaySummary } from "@/lib/local-db/schema";
import { getTelemetryRepo } from "@/lib/local-db/repositories";

function isoDay(date = new Date()): string {
  return date.toISOString().split("T")[0];
}

export function useTelemetrySummary(day?: string): { data: TelemetryDaySummary | null; isLoading: boolean } {
  const [data, setData] = useState<TelemetryDaySummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const date = day ?? isoDay();

  useEffect(() => {
    let active = true;
    const repo = getTelemetryRepo();

    setIsLoading(true);
    void repo.summarizeDay(date)
      .then((summary) => {
        if (!active) {
          return;
        }
        setData(summary);
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [date]);

  return { data, isLoading };
}
