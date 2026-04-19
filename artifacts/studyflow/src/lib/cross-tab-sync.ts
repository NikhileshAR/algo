/**
 * Cross-tab synchronization utilities.
 *
 * Uses the BroadcastChannel API to signal other open tabs/windows when
 * shared server state changes (session logged, schedule recalculated,
 * topics modified).  Recipients react by invalidating the relevant
 * React Query caches so every tab stays consistent without polling.
 *
 * Broadcasting is debounced with a 200ms batch window: multiple calls
 * within the window are coalesced into a single message per unique event
 * type, preventing rapid-fire re-fetch loops across tabs.
 *
 * BroadcastChannel is not available in all private-browsing / non-secure
 * contexts — all calls silently no-op when it is unavailable.
 */

import { logObservabilityEvent } from "./observability";

export type SyncEventName =
  | "session_logged"
  | "schedule_recalculated"
  | "topics_modified";

export interface SyncMessage {
  event: SyncEventName;
}

export const SYNC_CHANNEL_NAME = "sf-sync";

/** Debounce window for batching outbound sync events (ms). */
const BROADCAST_DEBOUNCE_MS = 200;

// Module-level debounce state — one batch per page/tab.
const _pendingBatch = new Set<SyncEventName>();
let _batchTimer: ReturnType<typeof setTimeout> | null = null;

function _flushBroadcastBatch(): void {
  const events = [..._pendingBatch];
  _pendingBatch.clear();
  _batchTimer = null;
  if (events.length === 0) return;

  logObservabilityEvent("sync_event_batched", { events, count: events.length });

  try {
    const channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    for (const event of events) {
      channel.postMessage({ event } as SyncMessage);
    }
    channel.close();
  } catch {
    // BroadcastChannel unavailable (private browsing, older browser) — ignore.
  }
}

/**
 * Post a sync event to all other open tabs.
 *
 * Multiple calls within BROADCAST_DEBOUNCE_MS are batched: duplicate events
 * are deduplicated (Set) and all unique events are sent together when the
 * debounce timer fires.
 */
export function broadcastSyncEvent(event: SyncEventName): void {
  _pendingBatch.add(event);
  if (_batchTimer !== null) return; // already scheduled — just add to batch
  _batchTimer = setTimeout(_flushBroadcastBatch, BROADCAST_DEBOUNCE_MS);
}
