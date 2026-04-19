/**
 * Cross-tab sync listener hook.
 *
 * Mount this once inside the QueryClientProvider (see App.tsx).
 * When another tab broadcasts a SyncEvent, the corresponding React Query
 * caches are invalidated in this tab so the UI stays consistent.
 *
 * Incoming messages are debounced with a 200ms window: events received
 * within the window are collected in a Set (deduplication) and all
 * affected query domains are invalidated in a single pass once the timer
 * fires.  This prevents rapid-fire cross-tab sync from triggering multiple
 * concurrent re-fetch rounds.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDashboardSummaryQueryKey,
  getGetPriorityTopicsQueryKey,
  getGetTodayScheduleQueryKey,
  getListSessionsQueryKey,
  getListTopicsQueryKey,
} from "@workspace/api-client-react";
import { studyflowQueryKeys } from "@/lib/query-keys";
import { SYNC_CHANNEL_NAME, type SyncEventName, type SyncMessage } from "@/lib/cross-tab-sync";
import { logObservabilityEvent } from "@/lib/observability";
import type { QueryClient } from "@tanstack/react-query";

/** Debounce window for batching inbound sync events (ms). */
const RECEIVE_DEBOUNCE_MS = 200;

/**
 * Invalidate only the query domains affected by the given set of sync events.
 * Scoped invalidation avoids unnecessary refetches for domains that did not
 * change.
 *
 * Domain mapping:
 *   session_logged    → sessions, schedule, dashboardSummary, priorityTopics, topics
 *   schedule_recalc   → schedule, dashboardSummary
 *   topics_modified   → topics, dashboardSummary, priorityTopics, schedule
 *
 * analyticsWeeklyReview is intentionally excluded from cross-tab invalidation
 * — it refreshes on page focus so there is no need to trigger a remote refetch
 * from another tab's session event.
 */
function applyDomainInvalidations(
  queryClient: QueryClient,
  events: Set<SyncEventName>,
): void {
  const needsSchedule =
    events.has("session_logged") ||
    events.has("schedule_recalculated") ||
    events.has("topics_modified");
  const needsSessions = events.has("session_logged");
  const needsDashboard = true; // every event type affects dashboard
  const needsPriorityTopics =
    events.has("session_logged") || events.has("topics_modified");
  const needsTopics =
    events.has("session_logged") || events.has("topics_modified");

  if (needsSchedule)
    queryClient.invalidateQueries({ queryKey: getGetTodayScheduleQueryKey() });
  if (needsSessions)
    queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
  if (needsDashboard)
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  if (needsPriorityTopics)
    queryClient.invalidateQueries({ queryKey: getGetPriorityTopicsQueryKey() });
  if (needsTopics)
    queryClient.invalidateQueries({ queryKey: getListTopicsQueryKey() });
}

export function useCrossTabSync(): void {
  const queryClient = useQueryClient();
  const pendingEventsRef = useRef<Set<SyncEventName>>(new Set());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function flush() {
      const events = pendingEventsRef.current;
      pendingEventsRef.current = new Set();
      debounceTimerRef.current = null;
      if (events.size === 0) return;
      logObservabilityEvent("cross_tab_sync_received", {
        events: [...events],
        count: events.size,
      });
      applyDomainInvalidations(queryClient, events);
      // also invalidate analytics weekly review on session events
      if (events.has("session_logged")) {
        queryClient.invalidateQueries({
          queryKey: studyflowQueryKeys.analyticsWeeklyReview(),
        });
      }
    }

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
      channel.onmessage = (e: MessageEvent<SyncMessage>) => {
        const { event } = e.data;
        pendingEventsRef.current.add(event);
        // Reset the debounce timer so all events within the window are batched.
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(flush, RECEIVE_DEBOUNCE_MS);
      };
    } catch {
      // BroadcastChannel unavailable — cross-tab sync silently disabled.
    }

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      try {
        channel?.close();
      } catch {
        // ignore cleanup errors
      }
    };
  }, [queryClient]);
}
