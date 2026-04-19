/**
 * Cross-tab sync listener hook.
 *
 * Mount this once inside the QueryClientProvider (see App.tsx).
 * When another tab broadcasts a SyncEvent, the corresponding React Query
 * caches are invalidated in this tab so the UI stays consistent.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDashboardSummaryQueryKey,
  getGetPriorityTopicsQueryKey,
  getGetTodayScheduleQueryKey,
  getListSessionsQueryKey,
  getListTopicsQueryKey,
} from "@workspace/api-client-react";
import { studyflowQueryKeys } from "@/lib/query-keys";
import { SYNC_CHANNEL_NAME, type SyncMessage } from "@/lib/cross-tab-sync";
import { logObservabilityEvent } from "@/lib/observability";

export function useCrossTabSync(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
      channel.onmessage = (e: MessageEvent<SyncMessage>) => {
        const { event } = e.data;
        logObservabilityEvent("cross_tab_sync_received", { event });

        if (event === "session_logged") {
          queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetPriorityTopicsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListTopicsQueryKey() });
          queryClient.invalidateQueries({ queryKey: studyflowQueryKeys.analyticsWeeklyReview() });
        } else if (event === "schedule_recalculated") {
          queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        } else if (event === "topics_modified") {
          queryClient.invalidateQueries({ queryKey: getListTopicsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetPriorityTopicsQueryKey() });
        }
      };
    } catch {
      // BroadcastChannel unavailable — cross-tab sync silently disabled.
    }

    return () => {
      try {
        channel?.close();
      } catch {
        // ignore cleanup errors
      }
    };
  }, [queryClient]);
}
