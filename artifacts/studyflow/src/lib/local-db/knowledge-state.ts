import { getDb } from "./idb";

export const MASTERY_STORE = "topic_mastery_states";

export interface TopicMasteryState {
  /** Matches the topic name (used as the primary key in the local-first model). */
  topicId: string;
  /** 0–1 learned mastery estimate. */
  mastery: number;
  /**
   * Ebbinghaus decay rate (λ). Higher → faster forgetting.
   * Well-practised topics converge to a lower λ over time.
   */
  retentionDecay: number;
  /** Unix timestamp (ms) of the last practice event. */
  lastPracticed: number;
  /** Number of distinct practice sessions recorded. */
  practiceCount: number;
}

// ---------------------------------------------------------------------------
// Retention helpers
// ---------------------------------------------------------------------------

/** Ebbinghaus exponential decay: R = M * e^(-λ * t_days) */
export function estimateRetention(state: TopicMasteryState, nowMs = Date.now()): number {
  // If the topic has never been practiced, there's no established retention.
  if (state.lastPracticed === 0) {
    return 0;
  }
  const daysSince = Math.max(0, (nowMs - state.lastPracticed) / 86_400_000);
  return Math.max(0, state.mastery * Math.exp(-state.retentionDecay * daysSince));
}

/**
 * Derive a sensible default λ from mastery level.
 * Low mastery → fast decay; high mastery → slow decay.
 */
export function defaultDecayRate(mastery: number): number {
  // λ in range [0.05, 0.35]
  return 0.35 - mastery * 0.3;
}

// ---------------------------------------------------------------------------
// Mastery update (feedback loop)
// ---------------------------------------------------------------------------

interface SessionSignal {
  /** Weighted quality score from TelemetryRepo (0–1). */
  qualityScore: number;
  /** Number of minutes of focused study in this session. */
  focusedMinutes: number;
}

/**
 * Returns an updated mastery state after a study session.
 * Uses an exponential moving average so mastery converges smoothly.
 */
export function applySessionToMastery(
  current: TopicMasteryState,
  signal: SessionSignal,
): TopicMasteryState {
  const n = current.practiceCount + 1;
  // Learning rate decreases as practice count grows (1/n style)
  const alpha = Math.max(0.05, 1 / n);
  // Minutes studied above 20 provide diminishing returns
  const effortBonus = Math.min(1, signal.focusedMinutes / 20) * 0.1;
  const rawUpdate = signal.qualityScore + effortBonus;
  const newMastery = Math.min(1, Math.max(0, current.mastery + alpha * (rawUpdate - current.mastery)));
  // Decay rate decreases as mastery grows (gets "stickier")
  const newDecay = defaultDecayRate(newMastery);

  return {
    ...current,
    mastery: Math.round(newMastery * 1000) / 1000,
    retentionDecay: Math.round(newDecay * 1000) / 1000,
    lastPracticed: Date.now(),
    practiceCount: n,
  };
}

// ---------------------------------------------------------------------------
// IndexedDB persistence
// ---------------------------------------------------------------------------

export async function getMasteryState(topicId: string): Promise<TopicMasteryState | null> {
  const db = await getDb();
  return new Promise<TopicMasteryState | null>((resolve, reject) => {
    const tx = db.transaction(MASTERY_STORE, "readonly");
    const req = tx.objectStore(MASTERY_STORE).get(topicId);
    req.onsuccess = () => resolve((req.result as TopicMasteryState | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllMasteryStates(): Promise<TopicMasteryState[]> {
  const db = await getDb();
  return new Promise<TopicMasteryState[]>((resolve, reject) => {
    const tx = db.transaction(MASTERY_STORE, "readonly");
    const req = tx.objectStore(MASTERY_STORE).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as TopicMasteryState[]);
    req.onerror = () => reject(req.error);
  });
}

export async function putMasteryState(state: TopicMasteryState): Promise<void> {
  const db = await getDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MASTERY_STORE, "readwrite");
    tx.objectStore(MASTERY_STORE).put(state);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function putMasteryStates(states: TopicMasteryState[]): Promise<void> {
  if (states.length === 0) {
    return;
  }
  const db = await getDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MASTERY_STORE, "readwrite");
    const store = tx.objectStore(MASTERY_STORE);
    for (const state of states) {
      store.put(state);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Bootstrap: ensure a mastery state exists for a topic
// ---------------------------------------------------------------------------

export function bootstrapMasteryState(
  topicId: string,
  initialMastery = 0.1,
): TopicMasteryState {
  return {
    topicId,
    mastery: initialMastery,
    retentionDecay: defaultDecayRate(initialMastery),
    lastPracticed: 0,
    practiceCount: 0,
  };
}

export async function ensureMasteryState(
  topicId: string,
  initialMastery = 0.1,
): Promise<TopicMasteryState> {
  const existing = await getMasteryState(topicId);
  if (existing) {
    return existing;
  }
  const fresh = bootstrapMasteryState(topicId, initialMastery);
  await putMasteryState(fresh);
  return fresh;
}
