import type { QueryClient } from "@tanstack/react-query";
import {
  getGetDashboardSummaryQueryKey,
  getGetPriorityTopicsQueryKey,
  getGetTodayScheduleQueryKey,
  getListSessionsQueryKey,
  getListTopicsQueryKey,
} from "@workspace/api-client-react";
import { studyflowQueryKeys } from "@/lib/query-keys";
import { broadcastSyncEvent } from "@/lib/cross-tab-sync";

export function invalidateAfterSessionLog(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
  queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
  queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  queryClient.invalidateQueries({ queryKey: getGetPriorityTopicsQueryKey() });
  queryClient.invalidateQueries({ queryKey: getListTopicsQueryKey() });
  queryClient.invalidateQueries({ queryKey: studyflowQueryKeys.analyticsWeeklyReview() });
  broadcastSyncEvent("session_logged");
}

export function invalidateAfterRecalculate(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
  queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  broadcastSyncEvent("schedule_recalculated");
}

export function invalidateAfterTopicsChange(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: getListTopicsQueryKey() });
  queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  queryClient.invalidateQueries({ queryKey: getGetPriorityTopicsQueryKey() });
  broadcastSyncEvent("topics_modified");
}
