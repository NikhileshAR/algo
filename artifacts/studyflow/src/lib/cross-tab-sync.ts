/**
 * Cross-tab synchronization utilities.
 *
 * Uses the BroadcastChannel API to signal other open tabs/windows when
 * shared server state changes (session logged, schedule recalculated,
 * topics modified).  Recipients react by invalidating the relevant
 * React Query caches so every tab stays consistent without polling.
 *
 * BroadcastChannel is not available in all private-browsing / non-secure
 * contexts — all calls silently no-op when it is unavailable.
 */

export type SyncEventName =
  | "session_logged"
  | "schedule_recalculated"
  | "topics_modified";

export interface SyncMessage {
  event: SyncEventName;
}

export const SYNC_CHANNEL_NAME = "sf-sync";

/**
 * Post a sync event to all other open tabs.  Fire-and-forget — errors are
 * swallowed because cross-tab sync is a best-effort enhancement.
 */
export function broadcastSyncEvent(event: SyncEventName): void {
  try {
    const channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    const msg: SyncMessage = { event };
    channel.postMessage(msg);
    channel.close();
  } catch {
    // BroadcastChannel unavailable (private browsing, older browser) — ignore.
  }
}
