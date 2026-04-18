import type { QueryClient } from "@tanstack/react-query";
import {
  getGetDashboardSummaryQueryKey,
  getGetPriorityTopicsQueryKey,
  getGetTodayScheduleQueryKey,
  getListSessionsQueryKey,
  getListTopicsQueryKey,
} from "@workspace/api-client-react";
import { studyflowQueryKeys } from "@/lib/query-keys";

export function invalidateAfterSessionLog(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
  queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
  queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  queryClient.invalidateQueries({ queryKey: getGetPriorityTopicsQueryKey() });
  queryClient.invalidateQueries({ queryKey: getListTopicsQueryKey() });
  queryClient.invalidateQueries({ queryKey: studyflowQueryKeys.analyticsWeeklyReview() });
}

export function invalidateAfterRecalculate(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
  queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
}
